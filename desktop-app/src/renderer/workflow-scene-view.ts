import type {
  ProductionQueueSnapshot,
  QueueErrorView,
  QueueJobView,
  QueueSceneView,
} from "../shared/production-queue";
import type { Scene, TimelineVideoSourceMode } from "../shared/timeline";

export type WorkflowAssetStatus =
  | "idle"
  | "waiting"
  | "submitted"
  | "processing"
  | "completed"
  | "approved"
  | "rejected"
  | "error"
  | "missing";

export interface WorkflowSceneView {
  scene: Scene;
  thumbnail?: string;
  queueScene: QueueSceneView | null;
  jobs: QueueJobView[];
  errors: QueueErrorView[];
  previousScene: Scene | null;
  nextScene: Scene | null;
  imageStatus: WorkflowAssetStatus;
  videoStatus: WorkflowAssetStatus;
  frameStatus: WorkflowAssetStatus;
  overallStatus: WorkflowAssetStatus;
  dependencyReady: boolean;
  retryCount: number;
  latestError: string;
}

function mediaStatus(
  scene: Scene,
  queueScene: QueueSceneView | null,
  mediaType: "image" | "video",
): WorkflowAssetStatus {
  const approved = mediaType === "image"
    ? scene.imageApproved || queueScene?.approvedImage
    : scene.videoApproved || queueScene?.approvedVideo;
  if (approved) return "approved";
  const state = mediaType === "image" ? scene.imageStatus : scene.videoStatus;
  if (state === "error" || queueScene?.status === `${mediaType}_failed`) return "error";
  if (state === "generating" || queueScene?.status === `${mediaType}_generating`) return "processing";
  if (state === "submitted" || queueScene?.status === `${mediaType}_submitted`) return "submitted";
  if (state === "queued" || queueScene?.status === `${mediaType}_queued`) return "waiting";
  const path = mediaType === "image"
    ? queueScene?.imageAssetPath || scene.imageResultPath
    : queueScene?.videoAssetPath || scene.videoResultPath;
  if (path || state === "done" || state === "review") return "completed";
  return "idle";
}

function overallStatus(statuses: WorkflowAssetStatus[]): WorkflowAssetStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("missing")) return "missing";
  if (statuses.includes("processing")) return "processing";
  if (statuses.includes("submitted")) return "submitted";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.every((status) => status === "approved" || status === "completed" || status === "idle")) {
    return statuses.includes("approved") ? "approved" : "completed";
  }
  return "idle";
}

export function buildWorkflowSceneViews(
  scenes: Scene[],
  snapshot: ProductionQueueSnapshot | null,
  thumbnails: Record<string, string>,
  options: { videoSourceMode?: TimelineVideoSourceMode } = {},
): WorkflowSceneView[] {
  const queueScenes = new Map((snapshot?.scenes || []).map((scene) => [scene.sceneId, scene]));
  const jobs = new Map<string, QueueJobView[]>();
  for (const job of snapshot?.jobs || []) jobs.set(job.sceneId, [...(jobs.get(job.sceneId) || []), job]);
  const errors = new Map<string, QueueErrorView[]>();
  for (const error of snapshot?.errors || []) errors.set(error.sceneId, [...(errors.get(error.sceneId) || []), error]);

  return scenes.map((scene, index) => {
    const queueScene = queueScenes.get(scene.id) || null;
    const previousScene = scenes[index - 1] || null;
    const nextScene = scenes[index + 1] || null;
    const directVideo = options.videoSourceMode === "direct";
    const imageStatus = directVideo ? "idle" : mediaStatus(scene, queueScene, "image");
    const videoStatus = mediaStatus(scene, queueScene, "video");
    const dependencyReady = directVideo || scene.chainRole !== "continue" || Boolean(queueScene?.startFrameAssetPath);
    const frameStatus: WorkflowAssetStatus = directVideo
      ? "idle"
      : scene.chainRole === "continue"
      ? dependencyReady ? "completed" : "missing"
      : nextScene?.chainRole === "continue"
        ? queueScenes.get(nextScene.id)?.startFrameAssetPath ? "completed" : videoStatus === "completed" || videoStatus === "approved" ? "waiting" : "idle"
        : "idle";
    const sceneJobs = jobs.get(scene.id) || [];
    const sceneErrors = errors.get(scene.id) || [];
    return {
      scene,
      thumbnail: thumbnails[scene.id],
      queueScene,
      jobs: sceneJobs,
      errors: sceneErrors,
      previousScene,
      nextScene,
      imageStatus,
      videoStatus,
      frameStatus,
      overallStatus: directVideo ? overallStatus([videoStatus]) : overallStatus([imageStatus, videoStatus, frameStatus]),
      dependencyReady,
      retryCount: sceneJobs.reduce((total, job) => total + Math.max(0, job.attempts - 1), 0),
      latestError: sceneErrors.at(-1)?.message || queueScene?.lastError || "",
    };
  });
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowAssetStatus, string> = {
  idle: "Chờ",
  waiting: "Đang chờ",
  submitted: "Đã gửi Flow",
  processing: "Đang xử lý",
  completed: "Hoàn thành",
  approved: "Đã duyệt",
  rejected: "Bị từ chối",
  error: "Lỗi",
  missing: "Thiếu phụ thuộc",
};
