import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { EditClip, EditProject } from "../shared/edit";
import {
  DEFAULT_VIDEO_ASSEMBLY_SETTINGS,
  type AssemblyMediaInfo,
  type AssemblyProgress,
  type AssemblyResult,
  type AssemblyValidation,
  type DurationMismatchStrategy,
  type VideoAssemblySettings,
} from "../shared/video-assembly";

const execFileAsync = promisify(execFile);

type ProgressListener = (progress: AssemblyProgress) => void;

interface ProbedClip {
  clip: EditClip;
  media: AssemblyMediaInfo;
  expectedDurationSeconds: number;
}

interface RunningAssembly {
  child: ChildProcess;
  outputPath: string;
  tempDirectory: string;
  cancelled: boolean;
}

function now(): string { return new Date().toISOString(); }

function ffmpegBinary(): string {
  return process.env.KC_FFMPEG_PATH || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBinary(): string {
  return process.env.KC_FFPROBE_PATH || process.env.FFPROBE_PATH || "ffprobe";
}

function parseRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : Number(value) || undefined;
}

function filterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function resolution(settings: VideoAssemblySettings): { width: number; height: number } {
  return settings.resolution === "1280x720" ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
}

function clampVolume(value: number): number { return Math.max(0, Math.min(2, value / 100)); }

function expectedDuration(clip: EditClip, media: AssemblyMediaInfo, strategy: DurationMismatchStrategy): number {
  if (strategy === "keep-original" && media.durationSeconds > 0) return media.durationSeconds;
  return Math.max(0.04, clip.durationMs / 1_000);
}

function uniqueOutputPath(root: string, requested: string): string {
  const path = resolve(requested);
  const extension = extname(path) || ".mp4";
  const withoutExtension = path.slice(0, -extension.length);
  return path || join(root, `kc-auto-final-${Date.now()}${extension}`);
}

function safeOutputPath(root: string, requested: string): string {
  const path = resolve(requested);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) throw new Error("Thư mục output phải nằm trong Vyren AI.");
  return path;
}

async function exists(path: string): Promise<boolean> {
  return Boolean(path && await stat(path).catch(() => null));
}

export class VideoAssemblyService {
  private readonly running = new Map<string, RunningAssembly>();
  private readonly listeners = new Set<ProgressListener>();

  constructor(private readonly outputRoot: string) {}

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(progress: AssemblyProgress): void {
    for (const listener of this.listeners) listener(progress);
  }

  sortClips(project: EditProject): EditClip[] {
    return project.clips
      .filter((clip) => clip.kind === "video" && clip.visible)
      .slice()
      .sort((left, right) => {
        const leftOrder = left.sceneNumber ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.sceneNumber ?? Number.MAX_SAFE_INTEGER;
        return left.startMs - right.startMs || leftOrder - rightOrder || left.id.localeCompare(right.id);
      });
  }

  async probeMedia(filePath: string): Promise<AssemblyMediaInfo | null> {
    if (!await exists(filePath)) return null;
    try {
      const { stdout } = await execFileAsync(ffprobeBinary(), [
        "-v", "error",
        "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
        "-of", "json", filePath,
      ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const data = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{ index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
      };
      const streams = data.streams || [];
      const video = streams.find((stream) => stream.codec_type === "video");
      const audio = streams.find((stream) => stream.codec_type === "audio");
      return {
        path: filePath,
        durationSeconds: Math.max(0, Number(data.format?.duration || 0)),
        width: video?.width,
        height: video?.height,
        fps: parseRate(video?.r_frame_rate),
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
        codec: video?.codec_name,
        sampleRate: Number(audio?.sample_rate || 0) || undefined,
        channels: audio?.channels,
      };
    } catch {
      return null;
    }
  }

  async validate(project: EditProject, settingsInput: VideoAssemblySettings): Promise<AssemblyValidation> {
    const settings = { ...DEFAULT_VIDEO_ASSEMBLY_SETTINGS, ...settingsInput };
    const clips = this.sortClips(project);
    const results: AssemblyValidation["scenes"] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const ready: ProbedClip[] = [];
    for (const clip of clips) {
      const media = await this.probeMedia(clip.sourcePath);
      const clipWarnings: string[] = [];
      const expected = Math.max(0.04, clip.durationMs / 1_000);
      if (!media?.hasVideo) {
        results.push({ sceneId: clip.sceneId || clip.id, sceneNumber: clip.sceneNumber || 0, label: clip.label, path: clip.sourcePath, expectedDurationSeconds: expected, media, status: "missing", warnings: ["Không tìm thấy video hoặc video không có video stream."] });
        continue;
      }
      if (Math.abs(media.durationSeconds - expected) > 0.25) clipWarnings.push(`Thời lượng lệch ${Math.abs(media.durationSeconds - expected).toFixed(2)} giây.`);
      if (media.width && media.height && Math.abs(media.width / media.height - 16 / 9) > 0.02) clipWarnings.push("Tỷ lệ video không phải 16:9; sẽ thêm nền đen để giữ toàn bộ nội dung.");
      if (!media.hasAudio) clipWarnings.push("Scene không có audio gốc; app sẽ tạo track im lặng an toàn.");
      results.push({ sceneId: clip.sceneId || clip.id, sceneNumber: clip.sceneNumber || 0, label: clip.label, path: clip.sourcePath, expectedDurationSeconds: expected, media, status: "ready", warnings: clipWarnings });
      ready.push({ clip, media, expectedDurationSeconds: expectedDuration(clip, media, settings.durationMismatchStrategy) });
    }
    const missingScenes = results.filter((result) => result.status !== "ready").map((result) => result.sceneNumber);
    if (!clips.length) errors.push("Phiên hiện tại chưa có video scene hợp lệ.");
    if (missingScenes.length) errors.push(`Thiếu hoặc không đọc được scene: ${missingScenes.join(", ")}.`);
    const voicePath = project.audioPath;
    const voiceMedia = voicePath ? await this.probeMedia(voicePath) : null;
    if (voicePath && !voiceMedia?.hasAudio) errors.push("Voice chính không có audio stream.");
    if (!voicePath) warnings.push("Không có voice chính; video hoàn chỉnh sẽ dùng audio gốc từ các clip scene.");
    const totalDurationSeconds = ready.reduce((sum, item) => sum + item.expectedDurationSeconds, 0);
    const voiceDurationSeconds = voiceMedia?.durationSeconds || 0;
    const outputDurationSeconds = Math.max(totalDurationSeconds, voiceDurationSeconds || totalDurationSeconds);
    if (voiceDurationSeconds > totalDurationSeconds + 0.05) warnings.push(`Voice dài hơn video ${(voiceDurationSeconds - totalDurationSeconds).toFixed(2)} giây; frame cuối sẽ được giữ lại.`);
    results.forEach((result) => result.warnings.forEach((message) => warnings.push(`Scene ${result.sceneNumber}: ${message}`)));
    if (settings.fadeInEnabled && settings.fadeInDurationSeconds > outputDurationSeconds / 2) warnings.push("Fade-in đã được tự giảm để không vượt quá một nửa thời lượng.");
    if (settings.fadeOutEnabled && settings.fadeOutDurationSeconds > outputDurationSeconds / 2) warnings.push("Fade-out đã được tự giảm để không vượt quá một nửa thời lượng.");
    const output = safeOutputPath(this.outputRoot, settings.outputPath || join(this.outputRoot, project.sessionId, "edit", "exports", settings.fileName || `${project.sessionId}-final-60fps.mp4`));
    await mkdir(dirname(output), { recursive: true }).catch(() => undefined);
    return { valid: errors.length === 0, scenes: results, missingScenes, errors, warnings, totalDurationSeconds, voiceDurationSeconds, outputDurationSeconds, voicePath };
  }

  buildFfmpegArguments(project: EditProject, settingsInput: VideoAssemblySettings, probes: ProbedClip[], outputPath: string, forcedOutputDuration?: number): string[] {
    const settings = { ...DEFAULT_VIDEO_ASSEMBLY_SETTINGS, ...settingsInput };
    const { width, height } = resolution(settings);
    const targetDuration = probes.reduce((sum, item) => sum + item.expectedDurationSeconds, 0);
    const filters: string[] = [];
    const inputArgs: string[] = ["-hide_banner", "-y", "-progress", "pipe:1", "-nostats"];
    const videoInputs: number[] = [];
    const audioInputs: number[] = [];
    let inputIndex = 0;
    for (const item of probes) {
      if (item.clip.trimInMs > 0) inputArgs.push("-ss", String(item.clip.trimInMs / 1_000));
      inputArgs.push("-i", item.clip.sourcePath);
      videoInputs.push(inputIndex++);
      if (item.media.hasAudio) audioInputs.push(inputIndex - 1);
      else {
        inputArgs.push("-f", "lavfi", "-t", String(item.expectedDurationSeconds), "-i", "anullsrc=r=48000:cl=stereo");
        audioInputs.push(inputIndex++);
      }
    }
    const hasVoice = Boolean(project.audioPath);
    const voiceIndex = hasVoice ? inputIndex : -1;
    if (hasVoice) inputArgs.push("-i", project.audioPath);
    const sceneVideoLabels: string[] = [];
    const sceneAudioLabels: string[] = [];
    probes.forEach((item, index) => {
      const duration = item.expectedDurationSeconds;
      const videoLabel = `v${index}`;
      const audioLabel = `a${index}`;
      filters.push(`[${videoInputs[index]}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${settings.fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[${videoLabel}]`);
      const sourceVideoVolume = !hasVoice && settings.sourceVideoVolume === DEFAULT_VIDEO_ASSEMBLY_SETTINGS.sourceVideoVolume
        ? 100
        : settings.sourceVideoVolume;
      const clipVolume = item.clip.muted ? 0 : sourceVideoVolume * Math.max(0, item.clip.volume) / 100;
      filters.push(`[${audioInputs[index]}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${clampVolume(clipVolume)}[${audioLabel}]`);
      sceneVideoLabels.push(`[${videoLabel}]`);
      sceneAudioLabels.push(`[${audioLabel}]`);
    });
    const concatInputs = probes.flatMap((_item, index) => [sceneVideoLabels[index], sceneAudioLabels[index]]).join("");
    filters.push(`${concatInputs}concat=n=${probes.length}:v=1:a=1[concatv][concata]`);
    const outputDuration = Math.max(forcedOutputDuration || targetDuration, 0.04);
    filters.push(`[concatv]tpad=stop_mode=clone:stop_duration=${Math.max(0, outputDuration - targetDuration)},trim=duration=${outputDuration},setpts=PTS-STARTPTS[videoBase]`);
    filters.push(`[concata]apad,atrim=duration=${outputDuration},asetpts=PTS-STARTPTS[sourceMix]`);
    if (hasVoice) {
      const voiceVolume = clampVolume(settings.voiceVolume);
      const voiceLabel = "voicea";
      filters.push(`[${voiceIndex}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=${voiceVolume},apad,atrim=duration=${outputDuration},asetpts=PTS-STARTPTS[${voiceLabel}]`);
      filters.push(`[sourceMix][${voiceLabel}]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]`);
    } else {
      filters.push("[sourceMix]alimiter=limit=0.95[mixed]");
    }
    const fadeIn = settings.fadeInEnabled ? Math.min(Math.max(0, settings.fadeInDurationSeconds), outputDuration / 2) : 0;
    const fadeOut = settings.fadeOutEnabled ? Math.min(Math.max(0, settings.fadeOutDurationSeconds), outputDuration / 2) : 0;
    let videoLabel = "videoBase";
    if (settings.includeSubtitles && project.subtitlePath) {
      const subtitleLabel = "subtitled";
      filters.push(`[${videoLabel}]subtitles=filename='${filterPath(project.subtitlePath)}'[${subtitleLabel}]`);
      videoLabel = subtitleLabel;
    }
    if (fadeIn > 0) filters.push(`[${videoLabel}]fade=t=in:st=0:d=${fadeIn}[fadein]`), videoLabel = "fadein";
    if (fadeOut > 0) filters.push(`[${videoLabel}]fade=t=out:st=${Math.max(0, outputDuration - fadeOut)}:d=${fadeOut}[fadeout]`), videoLabel = "fadeout";
    let audioLabel = "mixed";
    if (settings.audioFadeEnabled && (fadeIn > 0 || fadeOut > 0)) {
      if (fadeIn > 0) filters.push(`[${audioLabel}]afade=t=in:st=0:d=${fadeIn}[audiofadein]`), audioLabel = "audiofadein";
      if (fadeOut > 0) filters.push(`[${audioLabel}]afade=t=out:st=${Math.max(0, outputDuration - fadeOut)}:d=${fadeOut}[audiofadeout]`), audioLabel = "audiofadeout";
    }
    const preset = settings.quality === "high" ? "slow" : "medium";
    return [...inputArgs, "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-map", `[${audioLabel}]`, "-t", String(outputDuration), "-r", String(settings.fps), "-c:v", settings.videoCodec, "-preset", preset, "-crf", settings.quality === "high" ? "18" : "21", "-pix_fmt", "yuv420p", "-c:a", settings.audioCodec, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outputPath];
  }

  async start(project: EditProject, settingsInput: VideoAssemblySettings): Promise<AssemblyResult> {
    const jobId = `assembly-${randomUUID()}`;
    const settings = { ...DEFAULT_VIDEO_ASSEMBLY_SETTINGS, ...settingsInput };
    this.emit({ jobId, status: "validating", percent: 1, currentStep: "Kiểm tra file scene và voice…" });
    const validation = await this.validate(project, settings);
    if (!validation.valid) {
      const message = validation.errors.join(" ");
      this.emit({ jobId, status: "failed", percent: 0, currentStep: "Kiểm tra thất bại", errorMessage: message });
      throw new Error(message);
    }
    const probes = validation.scenes.flatMap((scene) => scene.media && scene.status === "ready"
      ? [{ clip: this.sortClips(project).find((clip) => (clip.sceneId || clip.id) === scene.sceneId)!, media: scene.media, expectedDurationSeconds: expectedDuration(this.sortClips(project).find((clip) => (clip.sceneId || clip.id) === scene.sceneId)!, scene.media, settings.durationMismatchStrategy) }]
      : []);
    const outputDirectory = join(this.outputRoot, project.sessionId, "edit", "exports");
    await mkdir(outputDirectory, { recursive: true });
    const requested = safeOutputPath(this.outputRoot, settings.outputPath || join(outputDirectory, settings.fileName || `${project.sessionId}-final-60fps.mp4`));
    const outputPath = await exists(requested) ? join(dirname(requested), `${requested.slice(0, -extname(requested).length)}-${Date.now()}${extname(requested) || ".mp4"}`) : uniqueOutputPath(outputDirectory, requested);
    const tempDirectory = join(this.outputRoot, project.sessionId, "edit", "temp", "video-assembly", jobId);
    await mkdir(tempDirectory, { recursive: true });
    this.emit({ jobId, status: "preparing", percent: 4, currentStep: "Chuẩn bị pipeline FFmpeg…", totalDurationSeconds: validation.outputDurationSeconds, outputPath });
    const args = this.buildFfmpegArguments(project, settings, probes, outputPath, validation.outputDurationSeconds);
    const child = spawn(ffmpegBinary(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const running: RunningAssembly = { child, outputPath, tempDirectory, cancelled: false };
    this.running.set(jobId, running);
    this.emit({ jobId, status: "encoding", percent: 8, currentStep: "Ghép scene, voice và áp dụng fade…", totalDurationSeconds: validation.outputDurationSeconds, outputPath });
    return await new Promise<AssemblyResult>((resolvePromise, rejectPromise) => {
      let stdoutBuffer = "";
      let stderr = "";
      const finish = async (error?: Error) => {
        this.running.delete(jobId);
        await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
        if (error || running.cancelled) await rm(outputPath, { force: true }).catch(() => undefined);
        if (running.cancelled) {
          this.emit({ jobId, status: "cancelled", percent: 0, currentStep: "Đã hủy ghép video", outputPath });
          rejectPromise(new Error("Đã hủy quá trình ghép video."));
        } else if (error) {
          this.emit({ jobId, status: "failed", percent: 0, currentStep: "Ghép video thất bại", errorMessage: error.message, outputPath });
          rejectPromise(error);
        } else {
          const result: AssemblyResult = { jobId, outputPath, durationMs: Math.round(validation.outputDurationSeconds * 1_000), width: resolution(settings).width, height: resolution(settings).height, fps: settings.fps, codec: settings.videoCodec === "libx265" ? "h265" : "h264", audioCodec: "aac", completedAt: now() };
          this.emit({ jobId, status: "completed", percent: 100, currentStep: "Đã ghép video hoàn chỉnh", totalDurationSeconds: validation.outputDurationSeconds, outputPath });
          resolvePromise(result);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        const values = new Map<string, string>();
        for (const line of lines) {
          const separator = line.indexOf("=");
          if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
        }
        const processed = Number(values.get("out_time_ms") || 0) / 1_000_000;
        if (processed > 0) {
          const percent = Math.min(99, Math.max(8, Math.round(processed / validation.outputDurationSeconds * 100)));
          this.emit({ jobId, status: "encoding", percent, currentStep: "Đang encode video hoàn chỉnh…", processedTimeSeconds: processed, totalDurationSeconds: validation.outputDurationSeconds, speed: Number.parseFloat(values.get("speed") || "") || undefined, estimatedRemainingSeconds: undefined, outputPath });
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", (error) => { void finish(error); });
      child.once("close", (code) => { void finish(code === 0 ? undefined : new Error(stderr.slice(-2_000) || `FFmpeg thoát với mã ${code}`)); });
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    const running = this.running.get(jobId);
    if (!running) return false;
    running.cancelled = true;
    running.child.kill("SIGTERM");
    setTimeout(() => { if (!running.child.killed) running.child.kill("SIGKILL"); }, 1_500);
    return true;
  }
}
