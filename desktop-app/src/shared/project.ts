export const SCENE_STATES = [
  "draft",
  "prompt_ready",
  "image_queued",
  "image_generating",
  "image_done",
  "image_failed",
  "image_approved",
  "video_queued",
  "video_generating",
  "video_submitted",
  "video_done",
  "video_failed",
  "video_approved",
  "needs_review",
  "skipped",
] as const;

export type SceneState = (typeof SCENE_STATES)[number];
export type JobState = "queued" | "running" | "succeeded" | "failed";
export type ChainRole = "single" | "start" | "continue";
export type SceneDuration = 4 | 6 | 8;

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  activeVisualBibleId: string | null;
  autoApproveImages: boolean;
  autoApproveVideos: boolean;
}

export interface VisualBibleRecord {
  id: string;
  projectId: string;
  version: number;
  stylePresetId: string | null;
  payloadJson: string;
  contentHash: string;
  locked: boolean;
  anchorImagePaths: string[];
  createdAt: string;
}

export interface SceneRecord {
  id: string;
  projectId: string;
  batchIndex: number;
  orderIndex: number;
  timeStart: string;
  timeEnd: string;
  imagePrompt: string;
  videoPrompt: string;
  usedCharacterTokens: string[];
  narrationSrtRange: string | null;
  visualBibleId: string | null;
  chainId: string | null;
  chainRole: ChainRole;
  durationSeconds: SceneDuration;
  startFrameAssetPath: string | null;
  status: SceneState;
  imageAssetPath: string | null;
  flowImageAssetId: string | null;
  videoAssetPath: string | null;
  approvedImage: boolean;
  approvedVideo: boolean;
  lastError: string | null;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  projectId: string;
  sceneId: string | null;
  jobType: string;
  status: JobState;
  dependsOn: string | null;
  attempts: number;
  maxAttempts: number;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSourceRecord {
  projectId: string;
  srtText: string;
  scriptText: string;
  srtFileName: string | null;
  scriptFileName: string | null;
  srtFilePath: string | null;
  scriptFilePath: string | null;
  audioFilePath: string | null;
  audioFileName: string | null;
  updatedAt: string;
}

export interface ProjectCharacterRecord {
  projectId: string;
  token: string;
  name: string;
  refImagePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface StylePresetRecord {
  id: string;
  name: string;
  category: string;
  paramSchemaJson: string;
  templateJson: string;
  anchorImagePaths: string[];
}
