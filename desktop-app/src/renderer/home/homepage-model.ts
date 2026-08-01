import type { ProductionQueueSnapshot, QueueErrorView, QueueJobView } from "../../shared/production-queue";
import {
  isVoiceWorkflowSourceReady,
  type Scene,
  type TimelineSession,
} from "../../shared/timeline";
import type { HomeWorkflowMode } from "../integrated-workflow";

export type HomepageState = "new-session" | "setup-in-progress" | "production-dashboard";
export type SetupStepStatus = "not-started" | "in-progress" | "completed" | "error";
export type ProductionSessionStatus = "ready" | "running" | "paused" | "stopped" | "error" | "completed";

export interface HomeCharacterSummary {
  total: number;
  main: number;
  recurring: number;
}

export interface SetupStepView {
  id: "source" | "characters" | "visual-bible" | "start";
  title: string;
  description: string;
  status: SetupStepStatus;
}

export interface ProductionSummary {
  totalScenes: number;
  completedVideos: number;
  submittedVideos: number;
  completedImages: number;
  requiredImages: number;
  finalFramesReady: number;
  finalFramesRequired: number;
  totalDurationSeconds: number;
  pendingJobs: number;
  runningJobs: number;
  errorJobs: number;
  blockedScenes: number;
  progressPercent: number;
  status: ProductionSessionStatus;
  activeJob: QueueJobView | null;
  retryableErrors: QueueErrorView[];
}

export interface ProductionControlAvailability {
  start: boolean;
  pause: boolean;
  resume: boolean;
  stop: boolean;
  retry: boolean;
  capCut: boolean;
}

function matchingQueue(session: TimelineSession, queue: ProductionQueueSnapshot | null): ProductionQueueSnapshot | null {
  return queue?.projectId === session.id ? queue : null;
}

export function deriveHomepageState(session: TimelineSession | null, mode: HomeWorkflowMode | null): HomepageState {
  if (!session || !mode) return "new-session";
  return session.scenes.length > 0 ? "production-dashboard" : "setup-in-progress";
}

export function sourceReady(session: TimelineSession, mode: HomeWorkflowMode): boolean {
  const source = session.workflowSource;
  if (mode === "script_to_media") {
    return Boolean(
      source.scriptText.trim() || source.scriptFileName.trim() || source.scriptPath.trim(),
    );
  }
  return isVoiceWorkflowSourceReady(source);
}

export function setupSteps(
  session: TimelineSession,
  mode: HomeWorkflowMode,
  charactersReviewed: boolean,
  validationError = false,
): SetupStepView[] {
  const sourceDone = sourceReady(session, mode);
  const charactersDone = mode === "script_to_media" ? sourceDone : charactersReviewed;
  const bibleDone = mode === "script_to_media"
    ? sourceDone
    : Boolean(session.visualBible.style.trim());
  const completed = [sourceDone, charactersDone, bibleDone];
  const firstIncomplete = completed.findIndex((value) => !value);
  const currentIndex = firstIncomplete < 0 ? 3 : firstIncomplete;
  const definitions: Array<Pick<SetupStepView, "id" | "title" | "description">> = [
    {
      id: "source",
      title: mode === "script_to_media" ? "Kịch bản" : "Voice audio & nội dung",
      description: mode === "script_to_media" ? "Nhập nội dung; timeline sẽ được lập tự động" : "Tạo voice bằng AI hoặc dùng MP3 có sẵn",
    },
    {
      id: "characters",
      title: mode === "script_to_media" ? "Phân tích tự động" : "Nhân vật",
      description: mode === "script_to_media" ? "Nhận diện cảnh, nhân vật và nhịp nội dung" : "Tạo nhân vật hoặc xác nhận không sử dụng",
    },
    {
      id: "visual-bible",
      title: mode === "script_to_media" ? "Phong cách & đầu ra" : "Visual Bible",
      description: mode === "script_to_media" ? "Tự tạo phong cách hoặc dùng thiết lập nâng cao" : "Khóa phong cách đồ họa và tính nhất quán",
    },
    { id: "start", title: "Bắt đầu workflow", description: mode === "script_to_media" ? "Tạo prompt và media theo lựa chọn" : "Chuẩn bị Voice/SRT, Timeline/Prompt và sản xuất" },
  ];
  return definitions.map((definition, index) => ({
    ...definition,
    status: validationError && index === currentIndex
      ? "error"
      : index < currentIndex || (index < 3 && completed[index])
        ? "completed"
        : index === currentIndex
          ? "in-progress"
          : "not-started",
  }));
}

function sceneVideoPath(scene: Scene, queue: ProductionQueueSnapshot | null): string {
  return queue?.scenes.find((item) => item.sceneId === scene.id)?.videoAssetPath || scene.videoResultPath;
}

function sceneVideoSubmitted(scene: Scene, queue: ProductionQueueSnapshot | null): boolean {
  return queue?.scenes.find((item) => item.sceneId === scene.id)?.status === "video_submitted" ||
    scene.videoStatus === "submitted";
}

function sceneImagePath(scene: Scene, queue: ProductionQueueSnapshot | null): string {
  return queue?.scenes.find((item) => item.sceneId === scene.id)?.imageAssetPath || scene.imageResultPath;
}

export function productionSummary(session: TimelineSession, queueInput: ProductionQueueSnapshot | null): ProductionSummary {
  const queue = matchingQueue(session, queueInput);
  const scenes = session.scenes;
  const outputTarget = session.workflowSource.sourceKind === "script"
    ? session.workflowSource.outputTarget || "video"
    : "video";
  const directScriptVideo = session.workflowSource.sourceKind === "script" &&
    outputTarget === "video" &&
    (session.workflowSource.videoSourceMode || "direct") === "direct";
  const requiredImages = directScriptVideo ? [] : scenes.filter((scene) => scene.chainRole !== "continue");
  const completedImages = requiredImages.filter((scene) => Boolean(sceneImagePath(scene, queue))).length;
  const completedVideos = scenes.filter((scene) => Boolean(sceneVideoPath(scene, queue))).length;
  const submittedVideos = scenes.filter((scene) => sceneVideoSubmitted(scene, queue)).length;
  const visibleVideoProgress = Math.max(completedVideos, submittedVideos);
  const continuationScenes = scenes.filter((scene) => scene.chainRole === "continue");
  const finalFramesReady = continuationScenes.filter((scene) =>
    Boolean(queue?.scenes.find((item) => item.sceneId === scene.id)?.startFrameAssetPath),
  ).length;
  const blockedScenes = outputTarget === "video" ? continuationScenes.filter((scene) => {
    const index = scenes.findIndex((item) => item.id === scene.id);
    const source = index > 0 ? scenes[index - 1] : null;
    const frameReady = Boolean(queue?.scenes.find((item) => item.sceneId === scene.id)?.startFrameAssetPath);
    const sourceFailed = Boolean(source && queue?.errors.some((error) => error.sceneId === source.id));
    return !frameReady && sourceFailed;
  }).length : 0;
  const errors = queue?.errors || [];
  const activeJob = queue?.jobs.find((job) => job.id === queue.activeJobId) || null;
  const progressPercent = outputTarget === "prompts"
    ? scenes.length > 0 ? 100 : 0
    : outputTarget === "images"
      ? requiredImages.length
        ? Math.round((completedImages / requiredImages.length) * 100)
        : 0
      : scenes.length
        ? Math.round((visibleVideoProgress / scenes.length) * 100)
        : 0;
  const status: ProductionSessionStatus = errors.length
    ? "error"
    : queue?.state === "running"
      ? "running"
      : queue?.state === "paused"
        ? "paused"
        : queue?.state === "stopped"
          ? "stopped"
          : outputTarget === "video" && scenes.length > 0 && completedVideos === scenes.length
            ? "completed"
            : outputTarget !== "video" && progressPercent === 100
            ? "completed"
            : "ready";
  return {
    totalScenes: scenes.length,
    completedVideos,
    submittedVideos,
    completedImages,
    requiredImages: requiredImages.length,
    finalFramesReady,
    finalFramesRequired: continuationScenes.length,
    totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    pendingJobs: queue?.queuedJobs || 0,
    runningJobs: activeJob ? 1 : 0,
    errorJobs: errors.length,
    blockedScenes,
    progressPercent,
    status,
    activeJob,
    retryableErrors: errors.filter((error) => error.retryable),
  };
}

export function nearestScenes(session: TimelineSession, activeSceneId: string, radius = 3): Scene[] {
  if (!session.scenes.length) return [];
  const index = Math.max(0, session.scenes.findIndex((scene) => scene.id === activeSceneId));
  const size = radius * 2 + 1;
  const start = Math.max(0, Math.min(index - radius, session.scenes.length - size));
  return session.scenes.slice(start, start + size);
}

export function jobLabel(job: QueueJobView | null, mediaType: "image" | "video" | null): string {
  if (!job) return "Hiện không có công việc đang chạy";
  if (job.jobType === "extract_last_frame") return "Trích frame cuối";
  if (/download/i.test(job.jobType)) return "Download";
  if (/policy/i.test(job.jobType)) return "Policy rewrite";
  return mediaType === "image" ? "Tạo ảnh" : "Tạo video";
}

export function productionControls(
  summary: ProductionSummary,
  mediaWorkersConnected: boolean,
  outputVideoFiles: number,
  outputTarget: "prompts" | "images" | "video" = "video",
): ProductionControlAvailability {
  const queueBusy = summary.status === "running" || summary.status === "paused";
  const resumableStoppedQueue = summary.status === "stopped" && summary.pendingJobs > 0;
  const resumableQueue = summary.status === "paused" || resumableStoppedQueue;
  return {
    start: outputTarget !== "prompts" &&
      !queueBusy &&
      !resumableStoppedQueue &&
      summary.status !== "completed" &&
      summary.errorJobs === 0 &&
      summary.blockedScenes === 0 &&
      mediaWorkersConnected,
    pause: summary.status === "running",
    resume: resumableQueue,
    stop: queueBusy,
    retry: summary.errorJobs > 0,
    capCut: outputTarget === "video" &&
      summary.progressPercent === 100 &&
      summary.blockedScenes === 0 &&
      !queueBusy &&
      outputVideoFiles >= summary.totalScenes,
  };
}
