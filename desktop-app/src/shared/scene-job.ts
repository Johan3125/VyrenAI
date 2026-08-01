import type { JobProgressStatus } from "./timeline";
import {
  normalizeVisualBible,
  type ProjectAspectRatio,
  type SceneDurationSeconds,
  type VisualBible,
} from "./timeline";
import { normalizeCharacterToken } from "./character";

export const SCENE_JOB_RUN_CHANNEL = "scene-job:run";
export const SCENE_JOB_CANCEL_CHANNEL = "scene-job:cancel";
export const SCENE_JOB_PROGRESS_CHANNEL = "scene-job:progress";

export const SCENE_MEDIA_TYPES = ["image", "video"] as const;
export type SceneMediaType = (typeof SCENE_MEDIA_TYPES)[number];

export const IMAGE_GENERATION_PROVIDERS = [
  "google-flow",
  "chatgpt-image",
  "grok-image",
  "gemini-image",
] as const;
export type ImageGenerationProvider = (typeof IMAGE_GENERATION_PROVIDERS)[number];
export const DEFAULT_IMAGE_GENERATION_PROVIDER: ImageGenerationProvider = "google-flow";

export const VIDEO_GENERATION_PROVIDERS = [
  "google-flow",
  "grok-video",
  "gemini-video",
  "capcut-video",
] as const;
export type VideoGenerationProvider = (typeof VIDEO_GENERATION_PROVIDERS)[number];
export const DEFAULT_VIDEO_GENERATION_PROVIDER: VideoGenerationProvider = "google-flow";

export function normalizeImageGenerationProvider(value: unknown): ImageGenerationProvider {
  return IMAGE_GENERATION_PROVIDERS.includes(value as ImageGenerationProvider)
    ? value as ImageGenerationProvider
    : DEFAULT_IMAGE_GENERATION_PROVIDER;
}

export function normalizeVideoGenerationProvider(value: unknown): VideoGenerationProvider {
  return VIDEO_GENERATION_PROVIDERS.includes(value as VideoGenerationProvider)
    ? value as VideoGenerationProvider
    : DEFAULT_VIDEO_GENERATION_PROVIDER;
}

export function imageModelForProvider(
  provider: ImageGenerationProvider,
): ImageGenerationSettings["model"] {
  if (provider === "chatgpt-image") return "chatgpt-web";
  if (provider === "grok-image") return "grok-imagine-web";
  if (provider === "gemini-image") return "gemini-web";
  return "nano-banana-pro";
}

export function videoModelForProvider(
  provider: VideoGenerationProvider,
): VideoGenerationSettings["model"] {
  if (provider === "grok-video") return "grok-imagine-video-web";
  if (provider === "gemini-video") return "gemini-omni-web";
  if (provider === "capcut-video") return "capcut-video-studio-web";
  return "veo-3.1-lite";
}

export interface SceneJobInput {
  sceneId: string;
  outputFolder?: string;
  mediaType: SceneMediaType;
  prompt: string;
  characterTokens: string[];
  visualBible: VisualBible;
  imageSettings: ImageGenerationSettings;
  sourceImagePath: string;
  sourceFlowAssetKey: string;
  startFramePath: string;
  videoSettings: VideoGenerationSettings;
}

export function projectOutputFolder(projectId: string, _projectName = ""): string {
  const normalized = String(projectId || "default")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
  const id = (normalized.startsWith("session-") ? normalized.slice(8) : normalized)
    .slice(-64) || "default";
  return `session-${id}`;
}

export interface ImageGenerationSettings {
  provider: ImageGenerationProvider;
  model: "nano-banana-pro" | "chatgpt-web" | "grok-imagine-web" | "gemini-web";
  aspectRatio: ProjectAspectRatio;
  outputCount: 1;
  expectedCredits: 0;
}

export interface VideoGenerationSettings {
  provider: VideoGenerationProvider;
  model: "veo-3.1-lite" | "grok-imagine-video-web" | "gemini-omni-web" | "capcut-video-studio-web";
  mode: "text-to-video" | "ingredients" | "first-frame" | "frames";
  delivery?: "submit-only" | "download";
  aspectRatio: ProjectAspectRatio;
  durationSeconds: SceneDurationSeconds;
  outputCount: 1;
  expectedCredits: 0;
}

export interface SceneReferenceImage {
  token: string;
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  imageBase64: string;
  localPath: string;
}

export interface BoundSceneJobInput extends SceneJobInput {
  refImages: SceneReferenceImage[];
  sourceImage?: SceneReferenceImage | null;
}

export interface SceneJobProgress {
  jobId: string;
  sceneId: string;
  mediaType: SceneMediaType;
  status: JobProgressStatus;
  message?: string;
}

export interface SceneJobResult {
  sceneId: string;
  mediaType: SceneMediaType;
  resultPath: string;
  flowAssetKey: string;
  status?: "downloaded" | "submitted";
  submittedAt?: string;
}

export interface SceneJobsBridge {
  run: (input: SceneJobInput) => Promise<SceneJobResult>;
  cancel: () => Promise<boolean>;
  onProgress: (callback: (progress: SceneJobProgress) => void) => () => void;
}

export function normalizeSceneJobInput(value: unknown): SceneJobInput {
  if (!value || typeof value !== "object") {
    throw new Error("Scene job input is invalid");
  }
  const input = value as Record<string, unknown>;
  const sceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const outputFolder = typeof input.outputFolder === "string"
    ? input.outputFolder.trim().replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80)
    : "default-session";
  if (!/^scene-\d{3,4}$/.test(sceneId)) {
    throw new Error("Scene job requires a valid scene id");
  }
  if (!SCENE_MEDIA_TYPES.includes(input.mediaType as SceneMediaType)) {
    throw new Error("Scene job media type is invalid");
  }
  if (!prompt || prompt.length > 20_000) {
    throw new Error("Scene prompt must contain 1-20000 characters");
  }
  const characterTokens = Array.isArray(input.characterTokens)
    ? [...new Set(input.characterTokens
      .map((token) => typeof token === "string" ? normalizeCharacterToken(token) : null)
      .filter((token): token is string => Boolean(token)))]
    : [];
  if (characterTokens.length > 4) {
    throw new Error("Mỗi scene chỉ hỗ trợ tối đa 4 nhân vật tham chiếu");
  }
  const visualBible = normalizeVisualBible(input.visualBible);
  const imageProvider = normalizeImageGenerationProvider(
    input.imageSettings && typeof input.imageSettings === "object"
      ? (input.imageSettings as Record<string, unknown>).provider
      : (input as Record<string, unknown>).imageProvider,
  );
  const imageSettings: ImageGenerationSettings = {
    provider: imageProvider,
    model: imageModelForProvider(imageProvider),
    aspectRatio: "16:9",
    outputCount: 1,
    expectedCredits: 0,
  };
  const videoProvider = normalizeVideoGenerationProvider(
    input.videoSettings && typeof input.videoSettings === "object"
      ? (input.videoSettings as Record<string, unknown>).provider
      : (input as Record<string, unknown>).videoProvider,
  );
  const videoSettings: VideoGenerationSettings = {
    provider: videoProvider,
    model: videoModelForProvider(videoProvider),
    mode: input.videoSettings && typeof input.videoSettings === "object" &&
      (input.videoSettings as Record<string, unknown>).mode === "text-to-video"
      ? "text-to-video"
      : input.videoSettings && typeof input.videoSettings === "object" &&
        (input.videoSettings as Record<string, unknown>).mode === "first-frame"
        ? "first-frame"
        : input.videoSettings && typeof input.videoSettings === "object" &&
          (input.videoSettings as Record<string, unknown>).mode === "frames"
          ? "frames"
          : "ingredients",
    delivery: input.videoSettings && typeof input.videoSettings === "object" &&
      (input.videoSettings as Record<string, unknown>).delivery === "download"
      ? "download"
      : "submit-only",
    aspectRatio: "16:9",
    durationSeconds: input.videoSettings && typeof input.videoSettings === "object" &&
      [4, 6, 8].includes(Number((input.videoSettings as Record<string, unknown>).durationSeconds))
      ? Number((input.videoSettings as Record<string, unknown>).durationSeconds) as SceneDurationSeconds
      : 8,
    outputCount: 1,
    expectedCredits: 0,
  };
  const sourceImagePath = typeof input.sourceImagePath === "string"
    ? input.sourceImagePath.trim()
    : "";
  if (
    input.mediaType === "video" &&
    videoSettings.mode !== "text-to-video" &&
    (!/^(?:[A-Za-z]:[\\/]|\/)/.test(sourceImagePath) ||
      !/\.(?:png|jpe?g|webp)$/i.test(sourceImagePath))
  ) {
    throw new Error("Video scene requires the completed image as its visual ingredient");
  }
  const sourceFlowAssetKey = typeof input.sourceFlowAssetKey === "string"
    ? input.sourceFlowAssetKey.trim().slice(0, 4_096)
    : "";
  const startFramePath = typeof input.startFramePath === "string"
    ? input.startFramePath.trim()
    : "";
  if (
    input.mediaType === "video" &&
    videoSettings.mode === "frames" &&
    (!/^(?:[A-Za-z]:[\\/]|\/)/.test(startFramePath) || !/\.(?:png|jpe?g|webp)$/i.test(startFramePath))
  ) {
    throw new Error("Frames video requires an extracted start frame");
  }
  return {
    sceneId,
    outputFolder: outputFolder || "default-session",
    mediaType: input.mediaType as SceneMediaType,
    prompt,
    characterTokens,
    visualBible,
    imageSettings,
    sourceImagePath: input.mediaType === "video" ? sourceImagePath : "",
    sourceFlowAssetKey: input.mediaType === "video" ? sourceFlowAssetKey : "",
    startFramePath: input.mediaType === "video" ? startFramePath : "",
    videoSettings,
  };
}

export function normalizeSceneJobResult(
  value: unknown,
  input: SceneJobInput,
): SceneJobResult {
  if (!value || typeof value !== "object") {
    throw new Error("Scene worker result is invalid");
  }
  const result = value as Record<string, unknown>;
  const status = result.status === "submitted" ? "submitted" : "downloaded";
  const resultPath =
    typeof result.resultPath === "string" ? result.resultPath.trim() : "";
  const flowAssetKey = typeof result.flowAssetKey === "string"
    ? result.flowAssetKey.trim().slice(0, 4_096)
    : "";
  if (
    result.sceneId !== input.sceneId ||
    result.mediaType !== input.mediaType ||
    (status === "submitted" && input.mediaType !== "video") ||
    (status === "downloaded" && !resultPath) ||
    resultPath.length > 2_048
  ) {
    throw new Error("Scene worker result does not match the requested scene");
  }
  const normalized: SceneJobResult = {
    sceneId: input.sceneId,
    mediaType: input.mediaType,
    resultPath,
    flowAssetKey: input.mediaType === "image" ? flowAssetKey : "",
    status,
  };
  if (typeof result.submittedAt === "string") normalized.submittedAt = result.submittedAt;
  return normalized;
}
