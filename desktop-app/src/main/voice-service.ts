import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Communicate, VoicesManager } from "edge-tts-universal";
import type {
  VoiceCatalogEntry,
  VoiceGenerateInput,
  VoiceGenerateResult,
  ImportedVoiceAudio,
  ImportedVoiceSubtitles,
  VoicePauseLevel,
  VoiceProvider,
  VoiceProgress,
  VoiceWordTiming,
} from "../shared/voice";
import { normalizeVoiceProvider } from "../shared/voice";
import { APP_BRAND_NAME } from "../shared/brand";

const MAX_CHARS_PER_REQUEST = 3_000;
const MIN_CHARS_PER_REQUEST = 500;
const SYNTHESIS_CONCURRENCY = 2;
const MAX_NARRATION_BYTES = 2 * 1024 * 1024;
const MAX_IMPORTED_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_IMPORTED_AUDIO_SECONDS = 6 * 60 * 60;

const CAPCUT_WEB_VOICE: VoiceCatalogEntry = {
  provider: "capcut-web",
  shortName: "capcut-web-default",
  locale: "vi-VN",
  gender: "Neutral",
  friendlyName: "CapCut Voice Web",
};

type GeneratedVoiceProvider = Exclude<VoiceProvider, "imported">;
type ValidatedVoiceGenerateInput = VoiceGenerateInput & {
  provider: GeneratedVoiceProvider;
};

const PAUSE_MILLISECONDS: Record<Exclude<VoicePauseLevel, "off">, Record<string, number>> = {
  medium: { sentence: 350, comma: 150, ellipsis: 650, dash: 300 },
  strong: { sentence: 550, comma: 220, ellipsis: 900, dash: 450 },
  dramatic: { sentence: 800, comma: 300, ellipsis: 1_200, dash: 600 },
};

interface SynthesizedChunk {
  text: string;
  audio: Buffer;
  words: VoiceWordTiming[];
  pauseKinds: Array<string | null>;
}

interface ActiveGeneration {
  id: string;
  cancelled: boolean;
  child: ChildProcessWithoutNullStreams | null;
}

interface ImportedAudioProbe {
  durationSeconds: number;
  codec: string;
  bitRateKbps: number;
  sampleRateHz: number;
  channels: number;
}

interface ImportedSrtAnalysis {
  srtText: string;
  transcript: string;
  cueCount: number;
  durationSeconds: number;
  warnings: string[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signedPercent(value: number): string {
  const safe = Math.max(-50, Math.min(50, Math.round(value / 5) * 5));
  return `${safe >= 0 ? "+" : ""}${safe}%`;
}

function signedHz(value: number): string {
  const safe = Math.max(-50, Math.min(50, Math.round(value / 5) * 5));
  return `${safe >= 0 ? "+" : ""}${safe}Hz`;
}

function safeProjectId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    throw new Error("Mã phiên làm việc không hợp lệ.");
  }
  return id;
}

function safeImportedBaseName(value: string): string {
  return parse(basename(value)).name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "voice-audio";
}

function srtTimeSeconds(value: string): number {
  const match = value.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3_600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1_000;
}

export function analyzeImportedSrt(
  value: string,
  audioDurationSeconds = 0,
): ImportedSrtAnalysis {
  const srtText = String(value || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!srtText || Buffer.byteLength(srtText, "utf8") > MAX_NARRATION_BYTES) {
    throw new Error("File SRT trống hoặc vượt quá giới hạn 2 MB.");
  }
  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const block of srtText.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(
      /(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{3})\s*-->\s*(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{3})/,
    );
    if (!timing) throw new Error("File SRT chứa timestamp không hợp lệ.");
    const start = srtTimeSeconds(timing[1]);
    const end = srtTimeSeconds(timing[2]);
    const text = lines.slice(timingIndex + 1).join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
      throw new Error("File SRT có cue trống hoặc thời gian kết thúc không hợp lệ.");
    }
    cues.push({ start, end, text });
  }
  if (!cues.length) throw new Error("File SRT không chứa subtitle có timestamp.");
  let overlapCount = 0;
  for (let index = 1; index < cues.length; index += 1) {
    if (cues[index].start < cues[index - 1].start) {
      throw new Error("Các cue SRT không được sắp xếp theo thời gian.");
    }
    if (cues[index].start < cues[index - 1].end) overlapCount += 1;
  }
  const durationSeconds = cues.at(-1)!.end;
  if (
    audioDurationSeconds > 0 &&
    durationSeconds > audioDurationSeconds + 2
  ) {
    throw new Error(
      `SRT dài hơn audio ${Math.ceil(durationSeconds - audioDurationSeconds)} giây. Hãy chọn đúng file đồng bộ.`,
    );
  }
  const warnings: string[] = [];
  if (overlapCount) warnings.push(`${overlapCount} cue SRT đang chồng thời gian.`);
  if (
    audioDurationSeconds > 0 &&
    audioDurationSeconds - durationSeconds > 5
  ) {
    warnings.push(
      `SRT kết thúc sớm hơn audio ${Math.ceil(audioDurationSeconds - durationSeconds)} giây.`,
    );
  }
  return {
    srtText: `${srtText}\n`,
    transcript: cues.map((cue) => cue.text).join(" "),
    cueCount: cues.length,
    durationSeconds,
    warnings,
  };
}

function probeImportedAudio(path: string): Promise<ImportedAudioProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "format=duration,bit_rate:stream=codec_name,sample_rate,channels,bit_rate",
      "-of", "json",
      path,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      reject(new Error(`Không chạy được FFprobe để kiểm tra MP3: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFprobe không đọc được file MP3: ${stderr.slice(-500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as {
          format?: { duration?: string; bit_rate?: string };
          streams?: Array<{
            codec_name?: string;
            sample_rate?: string;
            channels?: number;
            bit_rate?: string;
          }>;
        };
        const stream = result.streams?.[0];
        const durationSeconds = Number(result.format?.duration);
        const codec = String(stream?.codec_name || "").toLowerCase();
        if (
          codec !== "mp3" ||
          !Number.isFinite(durationSeconds) ||
          durationSeconds <= 0 ||
          durationSeconds > MAX_IMPORTED_AUDIO_SECONDS
        ) {
          throw new Error("File phải là MP3 hợp lệ, có audio và không dài quá 6 giờ.");
        }
        resolve({
          durationSeconds,
          codec,
          bitRateKbps: Math.max(0, Math.round(
            Number(stream?.bit_rate || result.format?.bit_rate || 0) / 1_000,
          )),
          sampleRateHz: Math.max(0, Number(stream?.sample_rate || 0)),
          channels: Math.max(0, Number(stream?.channels || 0)),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Metadata MP3 không hợp lệ."));
      }
    });
  });
}

function validateInput(input: VoiceGenerateInput): ValidatedVoiceGenerateInput {
  const provider = normalizeVoiceProvider(input?.provider);
  if (provider === "imported") {
    throw new Error("Import MP3/SRT does not create voice audio. Choose an MP3/SRT file or switch to a TTS provider.");
  }
  const narrationText = typeof input?.narrationText === "string"
    ? input.narrationText.trim()
    : "";
  if (!narrationText) throw new Error("File thoại là bắt buộc.");
  if (Buffer.byteLength(narrationText, "utf8") > MAX_NARRATION_BYTES) {
    throw new Error("File thoại vượt quá giới hạn 2 MB.");
  }
  const voice = typeof input?.voice === "string" ? input.voice.trim() : "";
  if (!voice) throw new Error("Hãy chọn giọng đọc trước khi bắt đầu.");
  const pauseLevel: VoicePauseLevel = ["off", "medium", "strong", "dramatic"].includes(
    input?.prosody?.pauseLevel,
  )
    ? input.prosody.pauseLevel
    : "off";
  return {
    provider,
    projectId: safeProjectId(input.projectId),
    projectName: String(input.projectName || APP_BRAND_NAME).trim().slice(0, 100),
    narrationText,
    narrationFileName: basename(String(input.narrationFileName || "loi-thoai.txt")),
    voice,
    prosody: {
      rate: Number.isFinite(input?.prosody?.rate) ? input.prosody.rate : 0,
      pitch: Number.isFinite(input?.prosody?.pitch) ? input.prosody.pitch : 0,
      volume: Number.isFinite(input?.prosody?.volume) ? input.prosody.volume : 0,
      pauseLevel,
    },
    splitMode: input.splitMode === "sentence" ? "sentence" : "paragraph",
    maxCharsPerChunk: Math.max(
      MIN_CHARS_PER_REQUEST,
      Math.min(MAX_CHARS_PER_REQUEST, Math.round(input.maxCharsPerChunk || MAX_CHARS_PER_REQUEST)),
    ),
    exportWordSrt: Boolean(input.exportWordSrt),
  };
}

function splitIntoChunks(text: string, mode: "paragraph" | "sentence", maxChars: number): string[] {
  const paragraphs = mode === "sentence"
    ? (text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text]).map((item) => item.trim()).filter(Boolean)
    : text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    const sentences = paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [paragraph];
    let sentenceChunk = "";
    for (const sentence of sentences) {
      const next = sentenceChunk ? `${sentenceChunk}${sentence}` : sentence;
      if (next.length <= maxChars) {
        sentenceChunk = next;
      } else {
        if (sentenceChunk.trim()) chunks.push(sentenceChunk.trim());
        if (sentence.length <= maxChars) {
          sentenceChunk = sentence;
        } else {
          for (let start = 0; start < sentence.length; start += maxChars) {
            chunks.push(sentence.slice(start, start + maxChars).trim());
          }
          sentenceChunk = "";
        }
      }
    }
    current = sentenceChunk;
  }
  pushCurrent();
  return chunks.length ? chunks : [text];
}

function classifyPunctuation(value: string): string | null {
  if (!value) return null;
  if (value.includes("…") || value.includes("...")) return "ellipsis";
  if (value.includes("—") || value.includes("–") || value.includes("--")) return "dash";
  if (/[.!?]/.test(value)) return "sentence";
  if (/[,;:]/.test(value)) return "comma";
  return null;
}

function detectPauseKinds(text: string, words: VoiceWordTiming[]): Array<string | null> {
  const result = new Array<string | null>(words.length).fill(null);
  let cursor = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index].text;
    if (!word) continue;
    const at = text.indexOf(word, cursor);
    if (at < 0) continue;
    const end = at + word.length;
    let lookahead = end;
    let punctuation = "";
    while (lookahead < text.length && lookahead < end + 8) {
      const character = text[lookahead];
      if (/\s/.test(character)) {
        lookahead += 1;
        continue;
      }
      if (/[.!?…,;:—–-]/.test(character)) {
        punctuation += character;
        lookahead += 1;
        continue;
      }
      break;
    }
    result[index] = classifyPunctuation(punctuation);
    cursor = end;
  }
  return result;
}

function srtTimestamp(secondsValue: number): string {
  const totalMilliseconds = Math.max(0, Math.round(secondsValue * 1_000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function buildVoiceSrt(words: VoiceWordTiming[]): string {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let current: VoiceWordTiming[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0].start,
      end: current.at(-1)!.end,
      text: current.map((word) => word.text).join(" "),
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    if (/[.!?…]$/.test(word.text) || current.length >= 10) flush();
  }
  flush();
  return cues.map((cue, index) =>
    `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`
  ).join("\n");
}

export function buildWordVoiceSrt(words: VoiceWordTiming[]): string {
  return words.map((word, index) =>
    `${index + 1}\n${srtTimestamp(word.start)} --> ${srtTimestamp(word.end)}\n${word.text}\n`
  ).join("\n");
}

function concatListPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

export class VoiceService {
  private voicesPromise: Promise<VoicesManager> | null = null;
  private active: ActiveGeneration | null = null;

  constructor(
    private readonly generatedMediaRoot: string,
    private readonly onProgress: (progress: VoiceProgress) => void,
  ) {}

  async importAudio(projectIdInput: string, sourcePath: string): Promise<ImportedVoiceAudio> {
    const projectId = safeProjectId(projectIdInput);
    if (extname(sourcePath).toLowerCase() !== ".mp3") {
      throw new Error("Chỉ chấp nhận file voice audio định dạng .mp3.");
    }
    const sourceInfo = await stat(sourcePath);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.size <= 0 ||
      sourceInfo.size > MAX_IMPORTED_AUDIO_BYTES
    ) {
      throw new Error("File MP3 trống hoặc vượt quá giới hạn 500 MB.");
    }
    const probe = await probeImportedAudio(sourcePath);
    const audioDirectory = join(this.generatedMediaRoot, projectId, "audio");
    await mkdir(audioDirectory, { recursive: true });
    const audioFileName = `voice-import-${Date.now()}-${safeImportedBaseName(sourcePath)}.mp3`;
    const audioPath = join(audioDirectory, audioFileName);
    await copyFile(sourcePath, audioPath);
    const copiedInfo = await stat(audioPath);
    if (copiedInfo.size !== sourceInfo.size) {
      await rm(audioPath, { force: true }).catch(() => undefined);
      throw new Error("Không thể xác minh file MP3 sau khi sao chép vào phiên.");
    }
    const warnings: string[] = [];
    if (probe.bitRateKbps > 0 && probe.bitRateKbps < 64) {
      warnings.push(`Bitrate ${probe.bitRateKbps} kbps khá thấp; giọng có thể bị méo hoặc nhiều nhiễu.`);
    }
    if (probe.sampleRateHz > 0 && probe.sampleRateHz < 22_050) {
      warnings.push(`Sample rate ${probe.sampleRateHz} Hz thấp hơn mức phù hợp cho voice video.`);
    }

    let subtitles: ImportedVoiceSubtitles | null = null;
    const sourceBase = parse(sourcePath);
    const sidecarPath = join(dirname(sourcePath), `${sourceBase.name}.srt`);
    try {
      await access(sidecarPath);
      subtitles = await this.importSubtitleFile(projectId, sidecarPath, probe.durationSeconds);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warnings.push(
          `Tìm thấy SRT cùng tên nhưng không thể dùng: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      audioPath,
      audioFileName,
      sourceFileName: basename(sourcePath),
      durationSeconds: probe.durationSeconds,
      sizeBytes: sourceInfo.size,
      codec: probe.codec,
      bitRateKbps: probe.bitRateKbps,
      sampleRateHz: probe.sampleRateHz,
      channels: probe.channels,
      warnings,
      subtitles,
    };
  }

  importSubtitles(
    projectId: string,
    sourcePath: string,
    audioDurationSeconds: number,
  ): Promise<ImportedVoiceSubtitles> {
    return this.importSubtitleFile(
      safeProjectId(projectId),
      sourcePath,
      Number.isFinite(audioDurationSeconds) ? audioDurationSeconds : 0,
    );
  }

  private async importSubtitleFile(
    projectId: string,
    sourcePath: string,
    audioDurationSeconds: number,
  ): Promise<ImportedVoiceSubtitles> {
    if (extname(sourcePath).toLowerCase() !== ".srt") {
      throw new Error("File subtitle phải có định dạng .srt.");
    }
    const sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > MAX_NARRATION_BYTES) {
      throw new Error("File SRT trống hoặc vượt quá giới hạn 2 MB.");
    }
    const analysis = analyzeImportedSrt(await readFile(sourcePath, "utf8"), audioDurationSeconds);
    const subtitleDirectory = join(this.generatedMediaRoot, projectId, "srt");
    await mkdir(subtitleDirectory, { recursive: true });
    const srtFileName = `voice-import-${Date.now()}-${safeImportedBaseName(sourcePath)}.srt`;
    const srtPath = join(subtitleDirectory, srtFileName);
    await writeFile(srtPath, analysis.srtText, "utf8");
    return {
      srtPath,
      srtFileName,
      ...analysis,
    };
  }

  async listVoices(providerInput: VoiceProvider = "edge"): Promise<VoiceCatalogEntry[]> {
    const provider = normalizeVoiceProvider(providerInput);
    if (provider === "imported") return [];
    if (provider === "capcut-web") return [CAPCUT_WEB_VOICE];
    if (!this.voicesPromise) this.voicesPromise = VoicesManager.create();
    try {
      const manager = await this.withTimeout(
        this.voicesPromise,
        20_000,
        "Hết thời gian tải danh sách giọng Edge TTS.",
      );
      return manager.find({}).map((voice) => ({
        provider: "edge",
        shortName: voice.ShortName,
        locale: voice.Locale,
        gender: voice.Gender,
        friendlyName: voice.FriendlyName,
      }));
    } catch (error) {
      this.voicesPromise = null;
      throw error;
    }
  }

  async preview(voice: string, locale: string, providerInput: VoiceProvider = "edge"): Promise<string> {
    const provider = normalizeVoiceProvider(providerInput);
    if (provider !== "edge") {
      throw new Error("Preview in app is only available for Microsoft Edge TTS. Use the provider web page for CapCut Voice Web preview.");
    }
    const text = locale.startsWith("vi-")
      ? `Xin chào, đây là giọng đọc mẫu của ${APP_BRAND_NAME}.`
      : `Hello, this is a sample voice from ${APP_BRAND_NAME}.`;
    const result = await this.synthesize(text, voice, 0, 0, 0);
    return `data:audio/mpeg;base64,${result.audio.toString("base64")}`;
  }

  async generate(rawInput: VoiceGenerateInput): Promise<VoiceGenerateResult> {
    if (this.active) throw new Error("Một công việc tạo voice khác đang chạy.");
    const input = validateInput(rawInput);
    if (input.provider === "capcut-web") {
      throw new Error("CapCut Voice Web is selected, but voice automation is not available in the extension yet. Use Edge TTS for generated voice, or generate/download audio on CapCut and import the MP3/SRT.");
    }
    const active: ActiveGeneration = { id: randomUUID(), cancelled: false, child: null };
    this.active = active;
    const outputDirectory = join(this.generatedMediaRoot, input.projectId, "audio");
    const subtitleDirectory = join(this.generatedMediaRoot, input.projectId, "srt");
    const temporaryDirectory = join(outputDirectory, `.voice-${active.id}`);
    await mkdir(temporaryDirectory, { recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(subtitleDirectory, { recursive: true });
    try {
      this.progress("preparing", 0, 1, "Đang chuẩn bị nội dung thoại…");
      const chunks = splitIntoChunks(input.narrationText, input.splitMode || "paragraph", input.maxCharsPerChunk || MAX_CHARS_PER_REQUEST);
      let synthesizedCompleted = 0;
      const synthesized = await this.runPooled(
        chunks,
        SYNTHESIS_CONCURRENCY,
        async (text, index) => {
          this.assertActive(active);
          const result = await this.withRetry(() => this.synthesize(
            text,
            input.voice,
            input.prosody.rate,
            input.prosody.pitch,
            input.prosody.volume,
            active,
          ));
          synthesizedCompleted += 1;
          this.progress(
            "synthesizing",
            synthesizedCompleted,
            chunks.length,
            `Đang tạo voice ${synthesizedCompleted}/${chunks.length} đoạn…`,
          );
          return { ...result, text, pauseKinds: detectPauseKinds(text, result.words) };
        },
      );
      this.assertActive(active);

      const chunkPaths: string[] = [];
      const chunkDurations: number[] = [];
      for (let index = 0; index < synthesized.length; index += 1) {
        const chunkPath = join(temporaryDirectory, `chunk-${String(index).padStart(4, "0")}.mp3`);
        await writeFile(chunkPath, synthesized[index].audio);
        chunkPaths.push(chunkPath);
        chunkDurations.push(await this.probeDuration(chunkPath, synthesized[index].words.at(-1)?.end || 0));
      }

      this.progress("joining", 0, 1, "Đang ghép các đoạn voice thành một file ổn định…");
      const concatFile = join(temporaryDirectory, "concat.txt");
      await writeFile(
        concatFile,
        chunkPaths.map((path) => `file '${concatListPath(path)}'`).join("\n"),
        "utf8",
      );
      const joinedPath = join(temporaryDirectory, "joined.mp3");
      await this.runCommand(active, "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-vn", "-c:a", "libmp3lame", "-q:a", "2", joinedPath,
      ]);

      const combinedWords: VoiceWordTiming[] = [];
      const combinedPauseKinds: Array<string | null> = [];
      let offset = 0;
      synthesized.forEach((chunk, index) => {
        chunk.words.forEach((word, wordIndex) => {
          combinedWords.push({
            text: word.text,
            start: word.start + offset,
            end: word.end + offset,
          });
          combinedPauseKinds.push(chunk.pauseKinds[wordIndex]);
        });
        offset += chunkDurations[index];
      });

      const timestamp = Date.now();
      let finalWords = combinedWords;
      let audioFileName = `voice-${timestamp}.mp3`;
      let audioPath = join(outputDirectory, audioFileName);
      if (input.prosody.pauseLevel === "off") {
        await writeFile(audioPath, await readFile(joinedPath));
      } else {
        this.progress("pauses", 0, 1, "Đang chèn khoảng nghỉ và đồng bộ lại timing…");
        audioFileName = `voice-${timestamp}.wav`;
        audioPath = join(outputDirectory, audioFileName);
        const insertions = combinedWords.flatMap((word, index) => {
          const kind = combinedPauseKinds[index];
          const durationMs = kind
            ? PAUSE_MILLISECONDS[input.prosody.pauseLevel as Exclude<VoicePauseLevel, "off">][kind] || 0
            : 0;
          return durationMs > 0 ? [{ at: word.end, duration: durationMs / 1_000 }] : [];
        });
        await this.insertPauses(active, joinedPath, audioPath, insertions);
        let added = 0;
        let insertionIndex = 0;
        finalWords = combinedWords.map((word) => {
          while (insertionIndex < insertions.length && insertions[insertionIndex].at < word.start - 0.000_5) {
            added += insertions[insertionIndex].duration;
            insertionIndex += 1;
          }
          const shifted = { text: word.text, start: word.start + added, end: word.end + added };
          while (insertionIndex < insertions.length && insertions[insertionIndex].at <= word.end + 0.000_5) {
            added += insertions[insertionIndex].duration;
            insertionIndex += 1;
          }
          return shifted;
        });
      }

      this.assertActive(active);
      this.progress("subtitles", 0, 1, "Đang xuất phụ đề SRT…");
      const srtText = buildVoiceSrt(finalWords);
      const srtFileName = `voice-${timestamp}.srt`;
      const srtPath = join(subtitleDirectory, srtFileName);
      await writeFile(srtPath, srtText, "utf8");
      const wordSrtFileName = input.exportWordSrt ? `voice-${timestamp}-words.srt` : "";
      const wordSrtPath = wordSrtFileName ? join(subtitleDirectory, wordSrtFileName) : "";
      if (wordSrtPath) await writeFile(wordSrtPath, buildWordVoiceSrt(finalWords), "utf8");
      const durationSeconds = await this.probeDuration(
        audioPath,
        finalWords.at(-1)?.end || 0,
      );
      const result: VoiceGenerateResult = {
        audioPath,
        audioFileName,
        srtPath,
        srtFileName,
        srtText,
        wordSrtPath,
        wordSrtFileName,
        durationSeconds,
        words: finalWords,
      };
      this.progress("done", 1, 1, "Đã tạo voice và SRT.");
      return result;
    } finally {
      active.child?.kill();
      if (this.active?.id === active.id) this.active = null;
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.cancelled = true;
    this.active.child?.kill();
    this.progress("stopping", 0, 1, "Đang dừng công việc tạo voice…");
    return true;
  }

  private async synthesize(
    text: string,
    voice: string,
    rate: number,
    pitch: number,
    volume: number,
    active?: ActiveGeneration,
  ): Promise<{ audio: Buffer; words: VoiceWordTiming[] }> {
    const communicate = new Communicate(text, {
      voice,
      rate: signedPercent(rate),
      pitch: signedHz(pitch),
      volume: signedPercent(volume),
    });
    const audio: Buffer[] = [];
    const words: VoiceWordTiming[] = [];
    const consume = async () => {
      for await (const chunk of communicate.stream()) {
        if (active?.cancelled) throw new Error("Đã dừng tạo voice.");
        if (chunk.type === "audio" && chunk.data) {
          audio.push(Buffer.from(chunk.data));
        } else if (chunk.type === "WordBoundary") {
          words.push({
            text: chunk.text || "",
            start: Number(chunk.offset || 0) / 10_000_000,
            end: Number((chunk.offset || 0) + (chunk.duration || 0)) / 10_000_000,
          });
        }
      }
    };
    const timeout = Math.min(120_000, Math.max(30_000, text.length * 30));
    await this.withTimeout(consume(), timeout, "Edge TTS không phản hồi trong thời gian cho phép.");
    if (!audio.length) throw new Error("Edge TTS không trả về dữ liệu âm thanh.");
    return { audio: Buffer.concat(audio), words };
  }

  private async insertPauses(
    active: ActiveGeneration,
    inputPath: string,
    outputPath: string,
    insertions: Array<{ at: number; duration: number }>,
  ): Promise<void> {
    if (!insertions.length) {
      await this.runCommand(active, "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-vn", "-c:a", "pcm_s16le", outputPath,
      ]);
      return;
    }
    const duration = await this.probeDuration(inputPath, insertions.at(-1)!.at);
    const pieces: string[] = [];
    const concatInputs: string[] = [];
    let cursor = 0;
    insertions.forEach((insertion, index) => {
      const segmentName = `a${index}`;
      const silenceName = `s${index}`;
      pieces.push(
        `[0:a]atrim=start=${cursor.toFixed(6)}:end=${insertion.at.toFixed(6)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[${segmentName}]`,
      );
      pieces.push(
        `anullsrc=r=44100:cl=stereo,atrim=duration=${insertion.duration.toFixed(6)}[${silenceName}]`,
      );
      concatInputs.push(`[${segmentName}]`, `[${silenceName}]`);
      cursor = insertion.at;
    });
    const tailName = `a${insertions.length}`;
    pieces.push(
      `[0:a]atrim=start=${cursor.toFixed(6)}:end=${duration.toFixed(6)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[${tailName}]`,
    );
    concatInputs.push(`[${tailName}]`);
    pieces.push(`${concatInputs.join("")}concat=n=${concatInputs.length}:v=0:a=1[out]`);
    const scriptPath = join(outputPath, "..", `.pause-filter-${randomUUID()}.txt`);
    await writeFile(scriptPath, pieces.join(";\n"), "utf8");
    try {
      await this.runCommand(active, "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-filter_complex_script", scriptPath, "-map", "[out]", "-c:a", "pcm_s16le", outputPath,
      ]);
    } finally {
      await rm(scriptPath, { force: true }).catch(() => undefined);
    }
  }

  private probeDuration(path: string, fallback: number): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path,
      ], { windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.on("error", () => resolve(fallback));
      child.on("close", (code) => {
        const value = Number.parseFloat(stdout.trim());
        resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : fallback);
      });
    });
  }

  private runCommand(active: ActiveGeneration, command: string, args: string[]): Promise<void> {
    this.assertActive(active);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      active.child = child;
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (active.child === child) active.child = null;
        if (active.cancelled) {
          reject(new Error("Đã dừng tạo voice."));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} thất bại (${code}): ${stderr.slice(-800)}`));
        }
      });
    });
  }

  private async runPooled<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runNext = async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
    return results;
  }

  private async withRetry<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /dừng tạo voice/i.test(error.message)) throw error;
        if (attempt < retries) await sleep(700 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]).finally(() => clearTimeout(timer!));
  }

  private assertActive(active: ActiveGeneration): void {
    if (active.cancelled || this.active?.id !== active.id) {
      throw new Error("Đã dừng tạo voice.");
    }
  }

  private progress(
    stage: VoiceProgress["stage"],
    completed: number,
    total: number,
    message: string,
  ): void {
    this.onProgress({ stage, completed, total, message });
  }
}
