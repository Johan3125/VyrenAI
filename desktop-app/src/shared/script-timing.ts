import type {
  SceneDurationSeconds,
  TimelinePacing,
} from "./timeline";

const WORDS_PER_SECOND: Record<TimelinePacing, number> = {
  quick: 3,
  balanced: 2.5,
  cinematic: 2.1,
};

const MAX_TIMELINE_SECONDS = 6 * 60 * 60;

export interface ScriptTimingCue {
  index: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: SceneDurationSeconds;
}

export interface ScriptTimingPlan {
  srtText: string;
  cues: ScriptTimingCue[];
  durationSeconds: number;
  wordCount: number;
}

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function cleanMarkdownLine(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitLongText(value: string, maxWords: number): string[] {
  if (words(value).length <= maxWords) return [value];
  const clauses = value
    .split(/(?<=[,;:—–])\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (clauses.length > 1 && clauses.every((item) => words(item).length <= maxWords)) {
    const grouped: string[] = [];
    for (const clause of clauses) {
      const previous = grouped.at(-1);
      if (previous && words(`${previous} ${clause}`).length <= maxWords) {
        grouped[grouped.length - 1] = `${previous} ${clause}`;
      } else {
        grouped.push(clause);
      }
    }
    return grouped;
  }
  const tokens = words(value);
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += maxWords) {
    chunks.push(tokens.slice(index, index + maxWords).join(" "));
  }
  return chunks;
}

function scriptSegments(scriptText: string, pacing: TimelinePacing): string[] {
  const normalized = scriptText
    .replace(/\r\n?/gu, "\n")
    .replace(/^\s*```[^\n]*$/gmu, "")
    .trim();
  const paragraphs = normalized
    .split(/\n{2,}/u)
    .flatMap((paragraph) => paragraph.split(/\n/u))
    .map(cleanMarkdownLine)
    .filter(Boolean);
  const maxWords = Math.max(12, Math.floor(WORDS_PER_SECOND[pacing] * 8));
  const raw = paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?…])\s+(?=[\p{L}\p{N}"“‘])/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .flatMap((item) => splitLongText(item, maxWords)),
  );
  const minimumWords = Math.max(4, Math.floor(WORDS_PER_SECOND[pacing] * 2));
  const merged: string[] = [];
  for (const segment of raw) {
    const previous = merged.at(-1);
    if (previous && words(segment).length < minimumWords &&
        words(`${previous} ${segment}`).length <= maxWords) {
      merged[merged.length - 1] = `${previous} ${segment}`;
    } else {
      merged.push(segment);
    }
  }
  if (merged.length > 1 && words(merged[0]).length < minimumWords) {
    const combined = `${merged[0]} ${merged[1]}`;
    if (words(combined).length <= maxWords) merged.splice(0, 2, combined);
  }
  return merged;
}

function cueDuration(text: string, pacing: TimelinePacing): SceneDurationSeconds {
  const punctuationPauses = (text.match(/[.!?…,:;]/gu) || []).length * 0.18;
  const estimated = words(text).length / WORDS_PER_SECOND[pacing] + punctuationPauses;
  if (estimated <= 4) return 4;
  if (estimated <= 6) return 6;
  return 8;
}

function srtTime(totalSeconds: number): string {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildScriptTimingPlan(
  scriptText: string,
  pacing: TimelinePacing = "balanced",
): ScriptTimingPlan {
  const source = scriptText.trim();
  if (!source) throw new Error("Kịch bản không được để trống");
  const segments = scriptSegments(source, pacing);
  if (!segments.length) throw new Error("Kịch bản không có nội dung có thể phân tích");
  let cursor = 0;
  const cues = segments.map((text, index): ScriptTimingCue => {
    const durationSeconds = cueDuration(text, pacing);
    const cue = {
      index: index + 1,
      text,
      startSeconds: cursor,
      endSeconds: cursor + durationSeconds,
      durationSeconds,
    };
    cursor = cue.endSeconds;
    return cue;
  });
  if (cursor > MAX_TIMELINE_SECONDS) {
    throw new Error("Kịch bản vượt quá thời lượng timeline tối đa 6 giờ");
  }
  return {
    cues,
    durationSeconds: cursor,
    wordCount: words(source).length,
    srtText: cues.map((cue) =>
      `${cue.index}\n${srtTime(cue.startSeconds)} --> ${srtTime(cue.endSeconds)}\n${cue.text}`,
    ).join("\n\n"),
  };
}
