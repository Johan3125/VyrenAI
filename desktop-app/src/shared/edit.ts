import type { TimelineSession } from "./timeline";
import type { VideoAssemblyBridge, VideoAssemblySettings } from "./video-assembly";

export const EDIT_LOAD_CHANNEL = "edit:load";
export const EDIT_SYNC_CHANNEL = "edit:sync";
export const EDIT_SAVE_CHANNEL = "edit:save";
export const EDIT_EXPORT_CHANNEL = "edit:export";
export const EDIT_PICK_VIDEO_CHANNEL = "edit:pick-video";

export type EditClipKind = "video" | "audio" | "subtitle" | "music";
export type EditWarningCode =
  | "missing_file"
  | "duration_short"
  | "duration_long"
  | "wrong_aspect"
  | "missing_audio"
  | "missing_subtitle"
  | "codec_unknown";

export interface EditWarning {
  code: EditWarningCode;
  message: string;
  severity: "warning" | "error";
}

export interface EditClip {
  id: string;
  kind: EditClipKind;
  sourcePath: string;
  label: string;
  startMs: number;
  durationMs: number;
  sourceDurationMs?: number;
  trimInMs: number;
  trimOutMs?: number;
  sceneId?: string;
  sceneNumber?: number;
  chainRole?: "single" | "start" | "continue";
  muted: boolean;
  volume: number;
  visible: boolean;
  locked: boolean;
  note?: string;
  warnings: EditWarning[];
}

export interface EditProject {
  id: string;
  sessionId: string;
  name: string;
  width: 1920;
  height: 1080;
  fps: 60;
  durationMs: number;
  clips: EditClip[];
  audioPath: string;
  subtitlePath: string;
  backgroundMusicPath: string;
  updatedAt: string;
  savedAt: string;
  status: "draft" | "ready" | "exporting" | "completed" | "error";
  lastExportPath?: string;
  lastError?: string;
}

export interface EditExportOptions {
  outputPath?: string;
  fileName?: string;
  includeSubtitles: boolean;
  includeMusic: boolean;
  quality: "standard" | "high";
  assembly?: Partial<VideoAssemblySettings>;
}

export interface EditExportResult {
  outputPath: string;
  durationMs: number;
  width: 1920;
  height: 1080;
  fps: 60;
  codec: "h264";
  audioCodec: "aac";
  completedAt: string;
}

export interface EditBridge {
  load: (session: TimelineSession) => Promise<EditProject>;
  sync: (session: TimelineSession) => Promise<EditProject>;
  save: (project: EditProject) => Promise<EditProject>;
  export: (project: EditProject, options: EditExportOptions) => Promise<EditExportResult>;
  pickVideo: (sessionId: string) => Promise<string | null>;
  assembly: VideoAssemblyBridge;
}
