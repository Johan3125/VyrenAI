import {
  isVoiceWorkflowSourceReady,
  type TimelineSession,
} from "../shared/timeline";
import type { HomeWorkflowMode } from "./integrated-workflow";

const HOME_MODE_KEY_PREFIX = "vyren-ai.session-home-mode.v1:";
const CHARACTERS_REVIEWED_KEY_PREFIX = "vyren-ai.session-characters-reviewed.v1:";
const MODES = new Set<HomeWorkflowMode>(["full_auto", "script_to_media", "step_by_step"]);
const LEGACY_SCRIPT_MODE = "srt_script";

export type HomeSessionPhase = "choose_mode" | "setup" | "production";

export interface HomeSetupState {
  phase: HomeSessionPhase;
  mode: HomeWorkflowMode | null;
  sourceReady: boolean;
  charactersReady: boolean;
  visualBibleReady: boolean;
  timelineReady: boolean;
  continuePage: "voice" | "characters" | "visual-bible" | "timeline";
  currentStep: "mode" | "source" | "characters" | "visual_bible" | "timeline" | "production";
}

function sourceHasContent(session: TimelineSession): boolean {
  const source = session.workflowSource;
  return Boolean(
    source.narrationText?.trim() || source.narrationFileName?.trim() ||
    source.srtText.trim() || source.srtFileName.trim() || source.srtPath.trim() ||
    source.scriptText.trim() || source.scriptFileName.trim() || source.audioPath.trim(),
  );
}

function inferLegacyMode(session: TimelineSession): HomeWorkflowMode | null {
  if (!sourceHasContent(session) && session.scenes.length === 0) return null;
  const source = session.workflowSource;
  const usedVoice = Boolean(
    source.audioPath.trim() || source.audioFileName.trim() ||
    source.narrationText?.trim() || source.narrationFileName?.trim(),
  );
  if (!usedVoice) return "script_to_media";
  return session.workflowMode === "automatic" ? "full_auto" : "step_by_step";
}

export function readHomeWorkflowMode(session: TimelineSession | null): HomeWorkflowMode | null {
  if (!session) return null;
  const rawStored = localStorage.getItem(`${HOME_MODE_KEY_PREFIX}${session.id}`);
  if (rawStored === LEGACY_SCRIPT_MODE) {
    saveHomeWorkflowMode(session.id, "script_to_media");
    return "script_to_media";
  }
  const stored = rawStored as HomeWorkflowMode | null;
  return stored && MODES.has(stored) ? stored : inferLegacyMode(session);
}

export function saveHomeWorkflowMode(sessionId: string, mode: HomeWorkflowMode): void {
  localStorage.setItem(`${HOME_MODE_KEY_PREFIX}${sessionId}`, mode);
}

export function readHomeCharactersReviewed(sessionId: string): boolean {
  return localStorage.getItem(`${CHARACTERS_REVIEWED_KEY_PREFIX}${sessionId}`) === "true";
}

export function markHomeCharactersReviewed(sessionId: string): void {
  localStorage.setItem(`${CHARACTERS_REVIEWED_KEY_PREFIX}${sessionId}`, "true");
}

export function deriveHomeSetupState(session: TimelineSession | null): HomeSetupState {
  if (!session) return {
    phase: "choose_mode",
    mode: null,
    sourceReady: false,
    charactersReady: false,
    visualBibleReady: false,
    timelineReady: false,
    continuePage: "timeline",
    currentStep: "mode",
  };
  const mode = readHomeWorkflowMode(session);
  const source = session.workflowSource;
  const sourceReady = mode === "script_to_media"
    ? Boolean(source.scriptText.trim() || source.scriptFileName.trim() || source.scriptPath.trim())
    : isVoiceWorkflowSourceReady(source);
  const visualBibleReady = mode === "script_to_media" || Boolean(session.visualBible.style.trim());
  const timelineReady = session.scenes.length > 0;
  const charactersReady = mode === "script_to_media" ||
    timelineReady ||
    readHomeCharactersReviewed(session.id);
  if (timelineReady) return {
    phase: "production",
    mode,
    sourceReady,
    charactersReady,
    visualBibleReady,
    timelineReady,
    continuePage: "timeline",
    currentStep: "production",
  };
  if (!mode) return {
    phase: "choose_mode",
    mode: null,
    sourceReady,
    charactersReady,
    visualBibleReady,
    timelineReady,
    continuePage: "timeline",
    currentStep: "mode",
  };
  const continuePage = mode !== "script_to_media" && !sourceReady
    ? "voice"
    : !charactersReady
      ? "characters"
      : !visualBibleReady
        ? "visual-bible"
        : "timeline";
  return {
    phase: "setup",
    mode,
    sourceReady,
    charactersReady,
    visualBibleReady,
    timelineReady,
    continuePage,
    currentStep: !sourceReady ? "source" : !charactersReady ? "characters" : !visualBibleReady ? "visual_bible" : "timeline",
  };
}

export const HOME_MODE_LABELS: Record<HomeWorkflowMode, string> = {
  full_auto: "Tự động toàn bộ video",
  script_to_media: "Kịch bản → Media",
  step_by_step: "Tạo từng bước",
};
