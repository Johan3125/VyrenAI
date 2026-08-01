import { ipcMain } from "electron";
import {
  DEFAULT_PROJECT_ID,
  QUEUE_CLEAR_GENERATED_MEDIA_CHANNEL,
  QUEUE_CLEAR_SCENE_MEDIA_CHANNEL,
  QUEUE_APPROVE_SCENE_CHANNEL,
  QUEUE_GENERATE_IMAGES_CHANNEL,
  QUEUE_GENERATE_VIDEOS_CHANNEL,
  QUEUE_PAUSE_CHANNEL,
  QUEUE_REGENERATE_SCENE_CHANNEL,
  QUEUE_REJECT_SCENE_CHANNEL,
  QUEUE_RESUME_CHANNEL,
  QUEUE_RESUME_FROM_CHANNEL,
  QUEUE_RETRY_FAILED_CHANNEL,
  QUEUE_SET_IMAGE_PROVIDER_CHANNEL,
  QUEUE_SET_VIDEO_PROVIDER_CHANNEL,
  QUEUE_SET_APPROVAL_POLICY_CHANNEL,
  QUEUE_SNAPSHOT_GET_CHANNEL,
  QUEUE_STOP_CHANNEL,
  type QueueGenerateOptions,
  type QueueVideoOptions,
} from "../shared/production-queue";
import {
  IMAGE_GENERATION_PROVIDERS,
  VIDEO_GENERATION_PROVIDERS,
  type ImageGenerationProvider,
  type SceneMediaType,
  type VideoGenerationProvider,
} from "../shared/scene-job";
import type { ProductionQueue } from "./production-queue";

function projectId(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : DEFAULT_PROJECT_ID;
}

function sceneId(value: unknown): string {
  if (typeof value !== "string" || !/^scene-\d{3,4}$/.test(value.trim())) {
    throw new Error("Scene id không hợp lệ");
  }
  return value.trim();
}

function mediaType(value: unknown): SceneMediaType {
  if (value !== "image" && value !== "video") throw new Error("Loại nội dung không hợp lệ");
  return value;
}

function imageProvider(value: unknown): ImageGenerationProvider {
  if (!IMAGE_GENERATION_PROVIDERS.includes(value as ImageGenerationProvider)) {
    throw new Error("Nhà cung cấp tạo ảnh không hợp lệ");
  }
  return value as ImageGenerationProvider;
}

function videoProvider(value: unknown): VideoGenerationProvider {
  if (!VIDEO_GENERATION_PROVIDERS.includes(value as VideoGenerationProvider)) {
    throw new Error("Nhà cung cấp tạo video không hợp lệ");
  }
  return value as VideoGenerationProvider;
}

export function registerProductionQueueIpcHandlers(queue: ProductionQueue): void {
  ipcMain.handle(QUEUE_SNAPSHOT_GET_CHANNEL, (_event, value?: unknown) =>
    queue.getSnapshot(projectId(value)));
  ipcMain.handle(QUEUE_GENERATE_IMAGES_CHANNEL, (
    _event,
    value?: { projectId?: unknown; options?: QueueGenerateOptions },
  ) => queue.generateAllImages(projectId(value?.projectId), value?.options));
  ipcMain.handle(QUEUE_GENERATE_VIDEOS_CHANNEL, (
    _event,
    value?: { projectId?: unknown; options?: QueueVideoOptions },
  ) => queue.generateAllVideos(projectId(value?.projectId), value?.options));
  ipcMain.handle(QUEUE_SET_IMAGE_PROVIDER_CHANNEL, (
    _event,
    value?: { provider?: unknown; projectId?: unknown },
  ) => queue.setImageProvider(
    imageProvider(value?.provider),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_SET_VIDEO_PROVIDER_CHANNEL, (
    _event,
    value?: { provider?: unknown; projectId?: unknown },
  ) => queue.setVideoProvider(
    videoProvider(value?.provider),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_PAUSE_CHANNEL, (
    _event,
    value?: { projectId?: unknown },
  ) => queue.pauseQueue(projectId(value?.projectId)));
  ipcMain.handle(QUEUE_RESUME_CHANNEL, (
    _event,
    value?: { projectId?: unknown },
  ) => queue.resumeQueue(projectId(value?.projectId)));
  ipcMain.handle(QUEUE_STOP_CHANNEL, (
    _event,
    value?: { projectId?: unknown },
  ) => queue.stopQueue(projectId(value?.projectId)));
  ipcMain.handle(QUEUE_CLEAR_GENERATED_MEDIA_CHANNEL, (
    _event,
    value?: { projectId?: unknown },
  ) => queue.clearGeneratedMedia(projectId(value?.projectId)));
  ipcMain.handle(QUEUE_CLEAR_SCENE_MEDIA_CHANNEL, (
    _event,
    value?: { sceneId?: unknown; projectId?: unknown },
  ) => queue.clearSceneMedia(
    sceneId(value?.sceneId),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_RETRY_FAILED_CHANNEL, (
    _event,
    value?: { sceneIds?: unknown; projectId?: unknown },
  ) => queue.retryFailed(
    Array.isArray(value?.sceneIds) ? value.sceneIds.map(sceneId) : [],
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_RESUME_FROM_CHANNEL, (
    _event,
    value?: { sceneId?: unknown; mediaType?: unknown; projectId?: unknown },
  ) => queue.resumeFrom(
    sceneId(value?.sceneId),
    mediaType(value?.mediaType),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_REGENERATE_SCENE_CHANNEL, (
    _event,
    value?: { sceneId?: unknown; mediaType?: unknown; projectId?: unknown },
  ) => queue.regenerateScene(
    sceneId(value?.sceneId),
    mediaType(value?.mediaType),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_APPROVE_SCENE_CHANNEL, (
    _event,
    value?: { sceneId?: unknown; mediaType?: unknown; projectId?: unknown },
  ) => queue.approveScene(
    sceneId(value?.sceneId),
    mediaType(value?.mediaType),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_REJECT_SCENE_CHANNEL, (
    _event,
    value?: { sceneId?: unknown; mediaType?: unknown; projectId?: unknown },
  ) => queue.rejectScene(
    sceneId(value?.sceneId),
    mediaType(value?.mediaType),
    projectId(value?.projectId),
  ));
  ipcMain.handle(QUEUE_SET_APPROVAL_POLICY_CHANNEL, (
    _event,
    value?: { images?: unknown; videos?: unknown; projectId?: unknown },
  ) => queue.setApprovalPolicy(
    value?.images === true,
    value?.videos === true,
    projectId(value?.projectId),
  ));
}
