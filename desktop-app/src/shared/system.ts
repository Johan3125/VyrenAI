import type { TimelineSession } from "./timeline";

export const SYSTEM_STATUS_CHANNEL = "system:get-status";
export const SYSTEM_OPEN_EXTENSION_FOLDER_CHANNEL = "system:open-extension-folder";
export const SYSTEM_OPEN_STORAGE_CHANNEL = "system:open-storage";
export const SYSTEM_SELECT_STORAGE_CHANNEL = "system:select-storage";
export const SYSTEM_RESTART_CHANNEL = "system:restart";
export const OUTPUT_INSPECT_CHANNEL = "output:inspect";
export const OUTPUT_OPEN_CHANNEL = "output:open";
export const OUTPUT_EXPORT_SESSION_CHANNEL = "output:export-session";

export interface SystemStatus {
  appVersion: string;
  cpuPercent: number | null;
  ramUsedBytes: number;
  ramTotalBytes: number;
  gpuPercent: number | null;
  ffmpegAvailable: boolean;
  ffmpegVersion: string;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  storageRoot: string;
  dataRoot: string;
  outputRoot: string;
  storageSource: "environment" | "drive-d" | "fallback";
  updatedAt: string;
}

export type OutputGroupId =
  | "audio"
  | "srt"
  | "prompts"
  | "images"
  | "videos"
  | "frames"
  | "logs"
  | "metadata";

export interface OutputFileView {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface OutputGroupView {
  id: OutputGroupId;
  count: number;
  sizeBytes: number;
  path: string;
  files: OutputFileView[];
}

export interface OutputInspection {
  projectId: string;
  rootPath: string;
  groups: OutputGroupView[];
  totalFiles: number;
  totalBytes: number;
  scannedAt: string;
}

export interface StorageSelectionResult {
  selected: boolean;
  rootPath: string;
  restartRequired: boolean;
}

export interface SystemBridge {
  getStatus: () => Promise<SystemStatus>;
  openExtensionFolder: () => Promise<string>;
  openStorage: (target: "root" | "data" | "outputs") => Promise<string>;
  selectStorage: () => Promise<StorageSelectionResult>;
  restart: () => Promise<void>;
  inspectOutput: (projectId: string) => Promise<OutputInspection>;
  openOutput: (projectId: string, group?: OutputGroupId) => Promise<string>;
  exportSession: (session: TimelineSession) => Promise<OutputInspection>;
}
