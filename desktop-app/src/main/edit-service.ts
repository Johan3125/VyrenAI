import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  EditClip,
  EditExportOptions,
  EditExportResult,
  EditProject,
  EditWarning,
} from "../shared/edit";
import type { AssemblyProgress, AssemblyResult, AssemblyValidation, VideoAssemblySettings } from "../shared/video-assembly";
import type { Scene, TimelineSession } from "../shared/timeline";
import { VideoAssemblyService } from "./video-assembly-service";

const execFileAsync = promisify(execFile);

function now(): string { return new Date().toISOString(); }

function timecodeToMs(value: string): number {
  const match = value.match(/^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
  if (!match) return 0;
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4].padEnd(3, "0"));
}

function sessionFolder(root: string, sessionId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(sessionId)) throw new Error("Mã phiên Edit không hợp lệ.");
  return join(root, sessionId);
}

function projectPath(root: string, sessionId: string): string {
  return join(sessionFolder(root, sessionId), "edit", "edit-project.json");
}

function safePath(root: string, value: string): string {
  const path = resolve(value);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) throw new Error("File dựng nằm ngoài thư mục Vyren AI.");
  return path;
}

function ffmpegFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

async function probeDuration(path: string): Promise<{ durationMs: number; width?: number; height?: number; fps?: number; hasAudio?: boolean }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", path], { windowsHide: true });
    const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }> };
    const stream = data.streams?.find((item) => item.codec_type === "video");
    const rate = stream?.r_frame_rate?.split("/").map(Number);
    return {
      durationMs: Math.round(Number(data.format?.duration || 0) * 1_000),
      width: stream?.width,
      height: stream?.height,
      fps: rate && rate[1] ? rate[0] / rate[1] : undefined,
      hasAudio: data.streams?.some((item) => item.codec_type === "audio") || false,
    };
  } catch {
    return { durationMs: 0 };
  }
}

async function findFirst(root: string, folders: string[], extensions: RegExp): Promise<string> {
  for (const folder of folders) {
    const target = join(root, folder);
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    const found = entries
      .filter((entry) => entry.isFile() && extensions.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name))[0];
    if (found) return join(target, found.name);
  }
  return "";
}

async function buildClip(scene: Scene): Promise<EditClip> {
  const expectedMs = scene.durationSeconds * 1_000;
  const sourcePath = scene.videoResultPath;
  const warnings: EditWarning[] = [];
  const probe = sourcePath && await fileExists(sourcePath) ? await probeDuration(sourcePath) : { durationMs: 0 };
  if (!sourcePath || !await fileExists(sourcePath)) {
    warnings.push({ code: "missing_file", message: "File video scene không tồn tại.", severity: "error" });
  } else if (probe.durationMs > 0 && probe.durationMs < expectedMs - 80) {
    warnings.push({ code: "duration_short", message: `Clip ngắn hơn thời lượng dự kiến ${(expectedMs - probe.durationMs) / 1_000}s.`, severity: "warning" });
  } else if (probe.durationMs > expectedMs + 80) {
    warnings.push({ code: "duration_long", message: "Clip dài hơn thời lượng scene và sẽ được trim khi xuất.", severity: "warning" });
  }
  if (probe.width && probe.height && Math.abs(probe.width / probe.height - 16 / 9) > 0.02) {
    warnings.push({ code: "wrong_aspect", message: "Tỷ lệ clip không phải 16:9.", severity: "warning" });
  }
  return {
    id: `clip-${scene.id}-${randomUUID().slice(0, 8)}`,
    kind: "video",
    sourcePath,
    label: `Scene ${scene.order}`,
    startMs: timecodeToMs(scene.timeStart),
    durationMs: expectedMs,
    sourceDurationMs: probe.durationMs || undefined,
    trimInMs: 0,
    trimOutMs: probe.durationMs || undefined,
    sceneId: scene.id,
    sceneNumber: scene.order,
    chainRole: scene.chainRole,
    muted: false,
    volume: 100,
    visible: true,
    locked: false,
    warnings,
  };
}

export class EditService {
  readonly assembly: VideoAssemblyService;

  constructor(private readonly outputRoot: string) {
    this.assembly = new VideoAssemblyService(outputRoot);
  }

  validateAssembly(project: EditProject, settings: VideoAssemblySettings): Promise<AssemblyValidation> {
    return this.assembly.validate(project, settings);
  }

  startAssembly(project: EditProject, settings: VideoAssemblySettings): Promise<AssemblyResult> {
    return this.assembly.start(project, settings);
  }

  cancelAssembly(jobId: string): Promise<boolean> {
    return this.assembly.cancel(jobId);
  }

  onAssemblyProgress(listener: (progress: AssemblyProgress) => void): () => void {
    return this.assembly.onProgress(listener);
  }

  async importVideo(sessionId: string, sourcePath: string): Promise<string> {
    if (!await fileExists(sourcePath)) throw new Error("File video đã chọn không tồn tại.");
    const extension = extname(sourcePath).toLowerCase();
    if (!new Set([".mp4", ".webm", ".mov", ".mkv"]).has(extension)) {
      throw new Error("Định dạng video không được hỗ trợ.");
    }
    const importsDirectory = join(sessionFolder(this.outputRoot, sessionId), "edit", "imports");
    await mkdir(importsDirectory, { recursive: true });
    const cleanName = basename(sourcePath, extension).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "replacement";
    const destination = join(importsDirectory, `${Date.now()}-${cleanName}${extension}`);
    await copyFile(sourcePath, destination);
    return destination;
  }

  async load(session: TimelineSession): Promise<EditProject> {
    const path = projectPath(this.outputRoot, session.id);
    const stored = await readFile(path, "utf8").then((value) => JSON.parse(value) as EditProject).catch(() => null);
    const sourceScenes = session.scenes.filter((scene) => Boolean(scene.videoResultPath));
    if (!stored || (stored.clips.length === 0 && sourceScenes.length > 0) || (!stored.audioPath && Boolean(session.workflowSource.audioPath))) {
      return this.sync(session);
    }
    return stored;
  }

  async sync(session: TimelineSession): Promise<EditProject> {
    const orderedScenes = session.scenes.slice().sort((left, right) => left.order - right.order);
    const clips = await Promise.all(orderedScenes
      .filter((scene) => scene.videoStatus === "done" || scene.videoStatus === "review" || Boolean(scene.videoResultPath))
      .map(buildClip));
    const audioPath = session.workflowSource.audioPath || await findFirst(sessionFolder(this.outputRoot, session.id), ["audio"], /\.(mp3|wav|m4a)$/i);
    const subtitlePath = session.workflowSource.srtPath || await findFirst(sessionFolder(this.outputRoot, session.id), ["srt", "subtitles"], /\.srt$/i);
    const timelineDurationMs = Math.max(timecodeToMs(orderedScenes.at(-1)?.timeEnd || "00:00:00,000"), ...clips.map((clip) => clip.startMs + clip.durationMs));
    const audioDurationMs = audioPath && await fileExists(audioPath) ? (await probeDuration(audioPath)).durationMs : 0;
    const durationMs = Math.max(timelineDurationMs, audioDurationMs);
    const project: EditProject = {
      id: `edit-${session.id}`,
      sessionId: session.id,
      name: `${session.name} · Edit`,
      width: 1920,
      height: 1080,
      fps: 60,
      durationMs,
      clips,
      audioPath,
      subtitlePath,
      backgroundMusicPath: "",
      updatedAt: now(),
      savedAt: now(),
      status: clips.length === orderedScenes.length && clips.length > 0 ? "ready" : "draft",
    };
    return this.save(project);
  }

  async save(project: EditProject): Promise<EditProject> {
    const path = projectPath(this.outputRoot, project.sessionId);
    await mkdir(join(this.outputRoot, project.sessionId, "edit"), { recursive: true });
    const next = { ...project, updatedAt: now(), savedAt: now() };
    await writeFile(path, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  async export(project: EditProject, options: EditExportOptions): Promise<EditExportResult> {
    const clips = project.clips.filter((clip) => clip.kind === "video" && clip.visible);
    if (!clips.length) throw new Error("Chưa có video scene để xuất.");
    let missing: EditClip | undefined;
    for (const clip of clips) {
      if (!clip.sourcePath || !await fileExists(clip.sourcePath)) {
        missing = clip;
        break;
      }
    }
    if (missing) throw new Error(`${missing.label}: file video không tồn tại.`);
    const exportDirectory = join(this.outputRoot, project.sessionId, "edit", "exports");
    await mkdir(exportDirectory, { recursive: true });
    const outputPath = safePath(this.outputRoot, options.outputPath || join(exportDirectory, options.fileName || `${project.sessionId}-final-60fps.mp4`));
    const args: string[] = ["-y"];
    clips.forEach((clip) => {
      if (clip.trimInMs > 0) args.push("-ss", String(clip.trimInMs / 1_000));
      if (clip.trimOutMs && clip.trimOutMs > clip.trimInMs) args.push("-t", String((clip.trimOutMs - clip.trimInMs) / 1_000));
      args.push("-i", clip.sourcePath);
    });
    const audioIndex = clips.length;
    if (!project.audioPath || !await fileExists(project.audioPath)) {
      throw new Error("Thiếu audio chính. Hãy đồng bộ lại dữ liệu phiên trước khi xuất video.");
    }
    const clipProbes = await Promise.all(clips.map((clip) => probeDuration(clip.sourcePath)));
    args.push("-i", project.audioPath);
    const durationSeconds = project.durationMs / 1_000;
    const filters: string[] = [`color=c=black:s=1920x1080:r=60:d=${durationSeconds}[base]`];
    clips.forEach((clip, index) => filters.push(`[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,tpad=stop_mode=clone:stop_duration=${clip.durationMs / 1_000},trim=duration=${clip.durationMs / 1_000},setpts=PTS-STARTPTS+${clip.startMs / 1_000}/TB[v${index}]`));
    let previous = "base";
    clips.forEach((_clip, index) => {
      const next = `layer${index}`;
      filters.push(`[${previous}][v${index}]overlay=eof_action=pass:shortest=0[${next}]`);
      previous = next;
    });
    if (options.includeSubtitles && project.subtitlePath && await fileExists(project.subtitlePath)) {
      filters.push(`[${previous}]subtitles=filename='${ffmpegFilterPath(project.subtitlePath)}'[outv]`);
    } else {
      filters.push(`[${previous}]null[outv]`);
    }
    filters.push(`[${audioIndex}:a]aresample=48000,volume=1[maina]`);
    const mixedAudioLabels = ["[maina]"];
    clips.forEach((clip, index) => {
      if (!clipProbes[index]?.hasAudio || clip.muted || clip.volume <= 0) return;
      filters.push(`[${index}:a]aresample=48000,volume=${clip.volume / 100},adelay=${Math.round(clip.startMs)}|${Math.round(clip.startMs)}[clipa${index}]`);
      mixedAudioLabels.push(`[clipa${index}]`);
    });
    if (mixedAudioLabels.length === 1) {
      filters.push(`[maina]apad,atrim=duration=${durationSeconds}[outa]`);
    } else {
      filters.push(`${mixedAudioLabels.join("")}amix=inputs=${mixedAudioLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${durationSeconds}[outa]`);
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-map", "[outa]", "-t", String(durationSeconds), "-r", "60", "-c:v", "libx264", "-preset", options.quality === "high" ? "slow" : "medium", "-crf", options.quality === "high" ? "18" : "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", outputPath);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("ffmpeg", args, { windowsHide: true });
      let error = "";
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(error.slice(-2_000) || `FFmpeg thoát với mã ${code}`)));
    });
    return { outputPath, durationMs: project.durationMs, width: 1920, height: 1080, fps: 60, codec: "h264", audioCodec: "aac", completedAt: now() };
  }
}
