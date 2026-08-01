import type { EditProject } from "./edit";

export const EDIT_ASSEMBLY_VALIDATE_CHANNEL = "edit:assembly-validate";
export const EDIT_ASSEMBLY_START_CHANNEL = "edit:assembly-start";
export const EDIT_ASSEMBLY_CANCEL_CHANNEL = "edit:assembly-cancel";
export const EDIT_ASSEMBLY_PROGRESS_CHANNEL = "edit:assembly-progress";

export type AssemblyJobStatus =
  | "idle"
  | "validating"
  | "preparing"
  | "normalizing"
  | "concatenating"
  | "mixing-audio"
  | "applying-fades"
  | "encoding"
  | "completed"
  | "failed"
  | "cancelled";

export type DurationMismatchStrategy = "trim-video" | "freeze-last-frame" | "loop-video" | "keep-original";

export interface VideoAssemblySettings {
  outputPath?: string;
  fileName?: string;
  resolution: "1920x1080" | "1280x720";
  fps: 24 | 25 | 30 | 60;
  videoCodec: "libx264" | "libx265";
  audioCodec: "aac";
  voiceVolume: number;
  sourceVideoVolume: number;
  fadeInEnabled: boolean;
  fadeInDurationSeconds: number;
  fadeOutEnabled: boolean;
  fadeOutDurationSeconds: number;
  audioFadeEnabled: boolean;
  durationMismatchStrategy: DurationMismatchStrategy;
  normalizeResolution: boolean;
  normalizeFps: boolean;
  includeSubtitles: boolean;
  includeMusic: boolean;
  quality: "standard" | "high";
}

export const DEFAULT_VIDEO_ASSEMBLY_SETTINGS: VideoAssemblySettings = {
  resolution: "1920x1080",
  fps: 60,
  videoCodec: "libx264",
  audioCodec: "aac",
  voiceVolume: 100,
  sourceVideoVolume: 0,
  fadeInEnabled: true,
  fadeInDurationSeconds: 0.5,
  fadeOutEnabled: true,
  fadeOutDurationSeconds: 0.5,
  audioFadeEnabled: true,
  durationMismatchStrategy: "freeze-last-frame",
  normalizeResolution: true,
  normalizeFps: true,
  includeSubtitles: false,
  includeMusic: false,
  quality: "standard",
};

export interface AssemblyMediaInfo {
  path: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  codec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface AssemblyValidation {
  valid: boolean;
  scenes: Array<{
    sceneId: string;
    sceneNumber: number;
    label: string;
    path: string;
    expectedDurationSeconds: number;
    media: AssemblyMediaInfo | null;
    status: "ready" | "missing" | "invalid";
    warnings: string[];
  }>;
  missingScenes: number[];
  errors: string[];
  warnings: string[];
  totalDurationSeconds: number;
  voiceDurationSeconds: number;
  outputDurationSeconds: number;
  voicePath: string;
}

export interface AssemblyProgress {
  jobId: string;
  status: AssemblyJobStatus;
  percent: number;
  currentStep: string;
  processedTimeSeconds?: number;
  totalDurationSeconds?: number;
  speed?: number;
  estimatedRemainingSeconds?: number;
  outputPath?: string;
  errorMessage?: string;
}

export interface AssemblyResult {
  jobId: string;
  outputPath: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec: "h264" | "h265";
  audioCodec: "aac";
  completedAt: string;
}

export interface VideoAssemblyBridge {
  validate: (project: EditProject, settings: VideoAssemblySettings) => Promise<AssemblyValidation>;
  start: (project: EditProject, settings: VideoAssemblySettings) => Promise<AssemblyResult>;
  cancel: (jobId: string) => Promise<boolean>;
  onProgress: (callback: (progress: AssemblyProgress) => void) => () => void;
}
