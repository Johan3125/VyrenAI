import {
  DEFAULT_TIMELINE_WORKFLOW_SOURCE,
  normalizeTimelineResult,
  normalizeTimelineWorkflowSource,
  type PromptFileVideoMode,
  type Scene,
  type SceneDurationSeconds,
  type TimelineWorkflowSource,
} from "./timeline";

export const PROMPT_FILE_IMPORT_CHANNEL = "timeline:import-prompt-file";

export type PromptFileIssueSeverity = "info" | "warning" | "blocking";

export interface PromptFileImportIssue {
  severity: PromptFileIssueSeverity;
  code: string;
  message: string;
  clipNumber?: number;
}

export interface PromptFileImportSummary {
  clipCount: number;
  totalDurationSeconds: number;
  minPromptChars: number;
  averagePromptChars: number;
  maxPromptChars: number;
  metadataStrippedCount: number;
  numberedClipCount: number;
  firstClipNumber: number | null;
  lastClipNumber: number | null;
  continuationCueCount: number;
}

export interface PromptFileImportResult {
  kind: "clip_prompt_file";
  sourceName: string;
  sourcePath: string;
  scriptText: string;
  srtText: string;
  scenes: Scene[];
  workflowSource: TimelineWorkflowSource;
  summary: PromptFileImportSummary;
  issues: PromptFileImportIssue[];
}

interface ParsedPromptLine {
  order: number;
  rawPrompt: string;
  videoPrompt: string;
  durationSeconds: SceneDurationSeconds;
  clipNumber: number | null;
  metadataStripped: boolean;
}

const MAX_PROMPT_CHARS = 20_000;
const PATH_TEXT_EXTENSIONS = /\.(?:txt|md)$/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const CLIP_NUMBER_PATTERN = /\bCLIP\s*0*(\d{1,4})\b/i;
const LEADING_DURATION_PATTERN = /^\s*(4|6|8)\s*[- ]\s*second\b/i;
const ANY_DURATION_PATTERN = /\b(?:duration|clip|shot)?\D*(4|6|8)\s*(?:s|sec|secs|second|seconds)\b/i;
const CONTINUATION_CUE_PATTERN = /\b(?:continue|continued|begin from the exact final frame|begin as|begin with|start from the final frame|same camera|same scene)\b/i;

export function detectLocalPromptFilePath(value: string): string | null {
  const candidate = value.trim().replace(/^["']|["']$/g, "");
  if (
    !candidate ||
    candidate.length > 4_096 ||
    /[\r\n]/.test(candidate) ||
    !ABSOLUTE_PATH_PATTERN.test(candidate) ||
    !PATH_TEXT_EXTENSIONS.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function sourceNameFromPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || "prompt-file.txt";
}

function formatTimecode(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},000`;
}

function durationFromPrompt(prompt: string): SceneDurationSeconds {
  const match = prompt.match(LEADING_DURATION_PATTERN) || prompt.match(ANY_DURATION_PATTERN);
  const duration = match ? Number(match[1]) : 8;
  return (duration === 4 || duration === 6 || duration === 8 ? duration : 8) as SceneDurationSeconds;
}

function stripClipMetadata(prompt: string): { prompt: string; stripped: boolean } {
  const next = prompt
    .replace(/(^|,\s*)CLIP\s*0*\d{1,4}\s*,\s*/i, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    prompt: next,
    stripped: next !== prompt.trim(),
  };
}

function isClipPromptFile(lines: string[]): boolean {
  if (lines.length === 0 || lines.length > 1_000) return false;
  const clipLikeCount = lines.filter((line) =>
    CLIP_NUMBER_PATTERN.test(line) || LEADING_DURATION_PATTERN.test(line)
  ).length;
  const longLineCount = lines.filter((line) => line.length >= 160).length;
  if (clipLikeCount / lines.length >= 0.6) return true;
  return lines.length >= 2 && longLineCount === lines.length;
}

function buildPromptSrt(clips: ParsedPromptLine[]): string {
  let cursor = 0;
  return clips.map((clip) => {
    const start = cursor;
    cursor += clip.durationSeconds;
    return [
      String(clip.order),
      `${formatTimecode(start)} --> ${formatTimecode(cursor)}`,
      clip.clipNumber ? `Clip ${String(clip.clipNumber).padStart(2, "0")}` : `Clip ${clip.order}`,
    ].join("\n");
  }).join("\n\n");
}

function buildWorkflowSource(
  scriptText: string,
  srtText: string,
  sourceName: string,
  sourcePath: string,
  promptFileVideoMode: PromptFileVideoMode = "direct-download",
): TimelineWorkflowSource {
  const direct = promptFileVideoMode !== "connected-chain";
  return normalizeTimelineWorkflowSource({
    ...DEFAULT_TIMELINE_WORKFLOW_SOURCE,
    sourceKind: "script",
    outputTarget: "video",
    videoSourceMode: direct ? "direct" : "image-first",
    directVideoDelivery: promptFileVideoMode === "direct-submit" ? "submit-only" : "download",
    promptFileVideoMode,
    pacing: "cinematic",
    timingOrigin: "script_estimated",
    scriptText,
    scriptFileName: sourceName || "prompt-file.txt",
    scriptPath: sourcePath,
    srtText,
    srtFileName: sourceName
      ? sourceName.replace(/\.(?:txt|md)$/i, ".srt")
      : "prompt-file.srt",
  });
}

function buildIssues(clips: ParsedPromptLine[]): PromptFileImportIssue[] {
  const issues: PromptFileImportIssue[] = [];
  const numbered = clips.filter((clip) => clip.clipNumber !== null);
  const allNumbered = numbered.length === clips.length;

  for (const clip of clips) {
    if (clip.videoPrompt.length > MAX_PROMPT_CHARS) {
      issues.push({
        severity: "blocking",
        code: "prompt_too_long",
        message: `Clip ${clip.order} exceeds ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`,
        clipNumber: clip.clipNumber || clip.order,
      });
    } else if (clip.videoPrompt.length > 8_000) {
      issues.push({
        severity: "warning",
        code: "prompt_very_long",
        message: `Clip ${clip.order} is unusually long and may be harder for the video provider to follow.`,
        clipNumber: clip.clipNumber || clip.order,
      });
    }
    if (!LEADING_DURATION_PATTERN.test(clip.rawPrompt)) {
      issues.push({
        severity: "info",
        code: "duration_defaulted",
        message: `Clip ${clip.order} has no leading duration; the importer used ${clip.durationSeconds}s.`,
        clipNumber: clip.clipNumber || clip.order,
      });
    }
  }

  if (numbered.length > 0 && !allNumbered) {
    issues.push({
      severity: "warning",
      code: "partial_clip_numbers",
      message: "Only some lines contain CLIP numbers; scene order follows file order.",
    });
  }

  if (allNumbered) {
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const clip of clips) {
      const clipNumber = clip.clipNumber!;
      if (seen.has(clipNumber)) duplicates.add(clipNumber);
      seen.add(clipNumber);
    }
    for (const duplicate of duplicates) {
      issues.push({
        severity: "blocking",
        code: "duplicate_clip_number",
        message: `CLIP ${String(duplicate).padStart(2, "0")} appears more than once.`,
        clipNumber: duplicate,
      });
    }
    const first = Math.min(...numbered.map((clip) => clip.clipNumber!));
    const last = Math.max(...numbered.map((clip) => clip.clipNumber!));
    const missing: number[] = [];
    for (let clipNumber = first; clipNumber <= last; clipNumber += 1) {
      if (!seen.has(clipNumber)) missing.push(clipNumber);
    }
    if (missing.length > 0) {
      issues.push({
        severity: "blocking",
        code: "missing_clip_number",
        message: `Missing CLIP ${missing.map((item) => String(item).padStart(2, "0")).join(", ")}.`,
      });
    }
    const outOfOrder = clips.some((clip, index) => clip.clipNumber !== first + index);
    if (outOfOrder) {
      issues.push({
        severity: "warning",
        code: "clip_number_order",
        message: "CLIP numbers are not in strict file order; imported scene order still follows the file.",
      });
    }
  }

  const stripped = clips.filter((clip) => clip.metadataStripped).length;
  if (stripped > 0) {
    issues.push({
      severity: "info",
      code: "clip_metadata_stripped",
      message: `Removed CLIP metadata from ${stripped} prompt${stripped === 1 ? "" : "s"} before sending to video generation.`,
    });
  }

  return issues;
}

export function analyzePromptFileText(
  text: string,
  options: { sourceName?: string; sourcePath?: string } = {},
): PromptFileImportResult | null {
  const scriptText = text.replace(/^\uFEFF/, "");
  const rawLines = scriptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!isClipPromptFile(rawLines)) return null;

  const clips: ParsedPromptLine[] = rawLines.map((rawPrompt, index) => {
    const clipMatch = rawPrompt.match(CLIP_NUMBER_PATTERN);
    const stripped = stripClipMetadata(rawPrompt);
    return {
      order: index + 1,
      rawPrompt,
      videoPrompt: stripped.prompt,
      durationSeconds: durationFromPrompt(rawPrompt),
      clipNumber: clipMatch ? Number(clipMatch[1]) : null,
      metadataStripped: stripped.stripped,
    };
  });
  const issues = buildIssues(clips);
  const cursorStart = 0;
  let cursor = cursorStart;
  const sceneInputs = clips.map((clip, index) => {
    const start = cursor;
    cursor += clip.durationSeconds;
    const hasChain = clips.length > 1;
    return {
      timeStart: formatTimecode(start),
      timeEnd: formatTimecode(cursor),
      durationSeconds: clip.durationSeconds,
      imagePrompt: "",
      videoPrompt: clip.videoPrompt,
      narration: clip.clipNumber ? `Clip ${String(clip.clipNumber).padStart(2, "0")}` : `Clip ${clip.order}`,
      visualPurpose: "Imported Google Flow video prompt",
      beatSummary: clip.videoPrompt.slice(0, 500),
      chainId: hasChain ? "imported-prompt-file" : null,
      chainRole: hasChain ? (index === 0 ? "start" : "continue") : "single",
      startingFrameSource: hasChain && index > 0 ? "previous-scene-final-frame" : "generated-image",
    };
  });
  const scenes = normalizeTimelineResult(
    { scenes: sceneInputs },
    { allowEmptyImagePrompts: true },
  ).scenes;
  const lengths = clips.map((clip) => clip.videoPrompt.length);
  const sourcePath = options.sourcePath?.trim() || "";
  const sourceName = options.sourceName?.trim() || (sourcePath ? sourceNameFromPath(sourcePath) : "prompt-file.txt");
  const srtText = buildPromptSrt(clips);
  const numbered = clips.filter((clip) => clip.clipNumber !== null);

  return {
    kind: "clip_prompt_file",
    sourceName,
    sourcePath,
    scriptText,
    srtText,
    scenes,
    workflowSource: buildWorkflowSource(scriptText, srtText, sourceName, sourcePath),
    summary: {
      clipCount: clips.length,
      totalDurationSeconds: clips.reduce((total, clip) => total + clip.durationSeconds, 0),
      minPromptChars: Math.min(...lengths),
      averagePromptChars: Math.round((lengths.reduce((total, length) => total + length, 0) / lengths.length) * 10) / 10,
      maxPromptChars: Math.max(...lengths),
      metadataStrippedCount: clips.filter((clip) => clip.metadataStripped).length,
      numberedClipCount: numbered.length,
      firstClipNumber: numbered.length ? Math.min(...numbered.map((clip) => clip.clipNumber!)) : null,
      lastClipNumber: numbered.length ? Math.max(...numbered.map((clip) => clip.clipNumber!)) : null,
      continuationCueCount: clips.filter((clip) => CONTINUATION_CUE_PATTERN.test(clip.rawPrompt)).length,
    },
    issues,
  };
}

function openingFramePrompt(videoPrompt: string): string {
  return [
    "Create the opening still frame for this video clip.",
    "Keep the same subject, camera framing, environment, visual style, and lighting described here:",
    videoPrompt,
  ].join(" ");
}

export function promptFileWorkflowSourceForMode(
  imported: PromptFileImportResult,
  promptFileVideoMode: PromptFileVideoMode,
): TimelineWorkflowSource {
  return buildWorkflowSource(
    imported.scriptText,
    imported.srtText,
    imported.sourceName,
    imported.sourcePath,
    promptFileVideoMode,
  );
}

export function promptFileScenesForMode(
  imported: PromptFileImportResult,
  promptFileVideoMode: PromptFileVideoMode,
): Scene[] {
  if (promptFileVideoMode !== "connected-chain") {
    return imported.scenes.map((scene) => ({
      ...scene,
      imagePrompt: "",
      imageStatus: "pending",
      imageResultPath: "",
      imageFlowAssetKey: "",
      imageApproved: false,
      startingFrameSource: scene.chainRole === "continue" ? "previous-scene-final-frame" : "generated-image",
    }));
  }

  const sceneInputs = imported.scenes.map((scene, index) => ({
    ...scene,
    imagePrompt: index === 0 ? openingFramePrompt(scene.videoPrompt) : "",
    imageStatus: "pending" as const,
    imageResultPath: "",
    imageFlowAssetKey: "",
    imageApproved: false,
    videoStatus: "pending" as const,
    videoResultPath: "",
    videoApproved: false,
    chainId: imported.scenes.length > 1 ? "imported-prompt-file" : null,
    chainRole: imported.scenes.length > 1 ? (index === 0 ? "start" : "continue") : "single",
    startingFrameSource: imported.scenes.length > 1 && index > 0 ? "previous-scene-final-frame" : "generated-image",
  }));
  return normalizeTimelineResult({ scenes: sceneInputs }).scenes;
}

export function importPromptFileText(
  text: string,
  options: { sourceName?: string; sourcePath?: string } = {},
): PromptFileImportResult {
  const result = analyzePromptFileText(text, options);
  if (!result) {
    throw new Error("File does not look like a clip prompt list. Expected one prompt per line with CLIP numbers or clear video-shot prompts.");
  }
  const blocking = result.issues.find((issue) => issue.severity === "blocking");
  if (blocking) throw new Error(blocking.message);
  return result;
}

export function scenesMatchPromptFileImport(
  scenes: Scene[],
  imported: PromptFileImportResult | null,
): boolean {
  if (!imported || scenes.length !== imported.scenes.length) return false;
  return scenes.every((scene, index) => {
    const candidate = imported.scenes[index];
    return Boolean(candidate) &&
      scene.videoPrompt === candidate.videoPrompt &&
      scene.durationSeconds === candidate.durationSeconds &&
      scene.timeStart === candidate.timeStart &&
      scene.timeEnd === candidate.timeEnd;
  });
}
