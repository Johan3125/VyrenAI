import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { CharacterStore } from "./character-store";
import type { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";
import type { TimelineSessionStore } from "./timeline-session-store";
import { syncTimelineSessionToProject } from "./production-session-sync";
import {
  DEFAULT_PROJECT_ID,
  QUEUE_ERROR_CATEGORIES,
  type ClearGeneratedMediaResult,
  type ClearSceneMediaResult,
  type ProductionQueueSnapshot,
  type QueueErrorCategory,
  type QueueGenerateOptions,
  type QueueRuntimeState,
  type QueueVideoOptions,
} from "../shared/production-queue";
import type { JobRecord, SceneRecord, SceneState } from "../shared/project";
import {
  DEFAULT_IMAGE_GENERATION_PROVIDER,
  DEFAULT_VIDEO_GENERATION_PROVIDER,
  imageModelForProvider,
  normalizeImageGenerationProvider,
  normalizeVideoGenerationProvider,
  projectOutputFolder,
  videoModelForProvider,
  type BoundSceneJobInput,
  type ImageGenerationProvider,
  type SceneJobProgress,
  type SceneJobResult,
  type SceneMediaType,
  type VideoGenerationProvider,
} from "../shared/scene-job";
import {
  normalizeVisualBible,
  isDirectVideoWorkflowSource,
  type PolicyFlag,
  type PolicyPromptRewriteInput,
  type PolicyPromptRewriteResult,
  type VisualBible,
} from "../shared/timeline";
import { APP_BRAND_NAME, STORAGE_FOLDER_NAME } from "../shared/brand";
import { WorkerJobError, type WorkerServer } from "./worker-server";
import type { WorkerRole } from "../shared/worker-status";
import { relocateSceneJobResult } from "./media-relocation";
import type { TextProvider } from "../shared/provider";
import { resolveSceneSourceImage } from "./scene-source-image";

const IMAGE_JOB = "image_generation";
const VIDEO_JOB = "video_generation";
const DIRECT_VIDEO_JOB = "video_generation_direct";
const VIDEO_SUBMIT_JOB = "video_submission";
const DIRECT_VIDEO_SUBMIT_JOB = "video_submission_direct";
const EXTRACT_FRAME_JOB = "extract_last_frame";
const LEGACY_QUEUE_STATE_METADATA_KEY = "production_queue_runtime_state";
const QUEUE_STATE_METADATA_PREFIX = `${LEGACY_QUEUE_STATE_METADATA_KEY}:`;
const IMAGE_PROVIDER_METADATA_PREFIX = "production_queue_image_provider:";
const VIDEO_PROVIDER_METADATA_PREFIX = "production_queue_video_provider:";

interface QueueWorker {
  runSceneJob: (
    input: BoundSceneJobInput,
    onProgress?: (progress: SceneJobProgress) => void,
  ) => Promise<SceneJobResult>;
  stopActiveJob: (role: WorkerRole, jobId?: string) => boolean;
  getAvailableSlots?: (role: WorkerRole) => number;
  getStatuses: WorkerServer["getStatuses"];
  rewritePolicyPrompt?: (
    input: PolicyPromptRewriteInput,
    onProgress?: (progress: import("../shared/timeline").TimelineProgress) => void,
  ) => Promise<PolicyPromptRewriteResult>;
}

interface QueueOptions {
  retryBackoffMs?: number[];
  maxAttempts?: number;
  heartbeatTimeoutMs?: number;
  watchdogIntervalMs?: number;
  disconnectedPollMs?: number;
  extractLastFrame?: (videoPath: string, outputPath: string) => Promise<void>;
  generatedMediaRoot?: string;
  getTextProvider?: () => TextProvider | Promise<TextProvider>;
  defaultImageProvider?: ImageGenerationProvider;
  defaultVideoProvider?: VideoGenerationProvider;
}

interface ProjectQueueRuntime {
  state: QueueRuntimeState;
  singleRunJobId: string | null;
  singleRunSceneIds: Set<string>;
  stateAfterSingleRun: "paused" | "stopped" | null;
  resumeRepairPending: boolean;
}

function createProjectRuntime(): ProjectQueueRuntime {
  return {
    state: "idle",
    singleRunJobId: null,
    singleRunSceneIds: new Set<string>(),
    stateAfterSingleRun: null,
    resumeRepairPending: false,
  };
}

interface StoredQueueError {
  category: QueueErrorCategory;
  message: string;
  retryable: boolean;
}

function now(): string {
  return new Date().toISOString();
}

type VideoJobMode = "image-first" | "direct";
type VideoDeliveryMode = "submit-only" | "download";

function payloadHash(
  scene: SceneRecord,
  mediaType: SceneMediaType,
  imageProvider: ImageGenerationProvider,
  videoProvider: VideoGenerationProvider,
  videoMode: VideoJobMode = "image-first",
  delivery: VideoDeliveryMode = "download",
): string {
  return createHash("sha256").update(JSON.stringify({
    sceneId: scene.id,
    mediaType,
    videoMode: mediaType === "video" ? videoMode : null,
    delivery: mediaType === "video" ? delivery : null,
    imageProvider: mediaType === "image" ? imageProvider : DEFAULT_IMAGE_GENERATION_PROVIDER,
    videoProvider: mediaType === "video" ? videoProvider : DEFAULT_VIDEO_GENERATION_PROVIDER,
    prompt: mediaType === "image" ? scene.imagePrompt : scene.videoPrompt,
    characters: scene.usedCharacterTokens,
    visualBibleId: scene.visualBibleId,
    sourceImage: mediaType === "video" && videoMode !== "direct"
      ? scene.chainRole === "continue"
        ? scene.startFrameAssetPath
        : scene.imageAssetPath
      : null,
  })).digest("hex");
}

function publicSceneId(projectId: string, sceneId: string | null): string {
  if (!sceneId) return "";
  const prefix = `${projectId}:`;
  return sceneId.startsWith(prefix) ? sceneId.slice(prefix.length) : sceneId;
}

function jobMediaType(jobType: string): SceneMediaType | null {
  if (jobType === IMAGE_JOB) return "image";
  if (isVideoJobType(jobType)) return "video";
  return null;
}

function isVideoJobType(jobType: string): boolean {
  return jobType === VIDEO_JOB ||
    jobType === DIRECT_VIDEO_JOB ||
    jobType === VIDEO_SUBMIT_JOB ||
    jobType === DIRECT_VIDEO_SUBMIT_JOB;
}

function videoJobMode(jobType: string): VideoJobMode {
  return jobType === DIRECT_VIDEO_JOB || jobType === DIRECT_VIDEO_SUBMIT_JOB
    ? "direct"
    : "image-first";
}

function videoJobDelivery(jobType: string): VideoDeliveryMode {
  return jobType === VIDEO_SUBMIT_JOB || jobType === DIRECT_VIDEO_SUBMIT_JOB
    ? "submit-only"
    : "download";
}

async function runFfmpegLastFrame(videoPath: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-sseof", "-0.05", "-i", videoPath,
      "-frames:v", "1", "-y", outputPath,
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg extract_last_frame failed (${code}): ${stderr.slice(-500)}`)));
  });
  await access(outputPath);
}

function serializeError(error: StoredQueueError): string {
  return JSON.stringify(error);
}

function parseError(value: string | null): StoredQueueError | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredQueueError>;
    if (
      QUEUE_ERROR_CATEGORIES.includes(parsed.category as QueueErrorCategory) &&
      typeof parsed.message === "string"
    ) {
      return {
        category: parsed.category as QueueErrorCategory,
        message: parsed.message,
        retryable: parsed.retryable === true,
      };
    }
  } catch {
    // Legacy errors are normalized below.
  }
  return {
    category: "response_schema_invalid",
    message: value,
    retryable: false,
  };
}

export function classifyQueueError(error: unknown): StoredQueueError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof WorkerJobError ? error.code : "INTERNAL_ERROR";
  const text = `${code} ${message}`.toLowerCase();
  if (
    /policy|safety|moderation|responsible ai|blocked.{0,20}prompt|prompt.{0,20}blocked|violation|vi pham|chinh sach|vi phạm|chính sách/.test(
      text,
    )
  ) {
    return { category: "flow_policy_violation", message, retryable: false };
  }
  if (
    code === "QUOTA_OR_RATE_LIMIT" ||
    /quota|rate.?limit|credit|too many requests|429|giới hạn/.test(text)
  ) {
    return { category: "flow_quota_or_rate_limit", message, retryable: true };
  }
  if (
    code === "FLOW_GENERATION_FAILED" ||
    /couldn['’]?t\s+generate|could\s+not\s+generate|unable\s+to\s+generate|generation\s+failed|unsuccessful|không\s+thành\s+công|rất\s+tiếc.*(?:xảy\s+ra|có)\s+lỗi|đã\s+xảy\s+ra\s+lỗi|không\s+thể\s+tạo|không\s+tạo\s+được/.test(
      text,
    )
  ) {
    // A generic Flow viewer failure is terminal for this attempt. The user can
    // retry explicitly after inspecting the viewer; automatic retry here could
    // submit a duplicate prompt while Flow is still settling the failed card.
    return { category: "flow_generation_failed", message, retryable: false };
  }
  if (/timeout|timed out|no response|stuck/.test(text) || code === "TIMEOUT") {
    return { category: "timeout_no_response", message, retryable: true };
  }
  if (
    /disconnect|not logged|worker.*kết nối|worker.*ket noi|socket|workspace_not_found/.test(text) ||
    code === "NOT_LOGGED_IN"
  ) {
    return { category: "extension_disconnected", message, retryable: true };
  }
  if (
    /element|selector|dom|not_found|not found|ui_changed|mode_not_found|attach_failed|clear_failed|submit_failed/.test(text)
  ) {
    return { category: "dom_element_not_found", message, retryable: true };
  }
  return {
    category: "response_schema_invalid",
    message,
    retryable: error instanceof WorkerJobError ? error.retryable : false,
  };
}

function inferPolicyFlag(message: string): PolicyFlag | null {
  const normalized = message.toLocaleLowerCase("vi-VN");
  if (/celebrity|public figure|real person|famous person|người thật|người nổi tiếng|nhân vật công chúng/.test(normalized)) return "real_person";
  if (/copyright|protected character|trademark|bản quyền/.test(normalized)) return "copyrighted_character";
  if (/minor|child safety|trẻ em|vị thành niên/.test(normalized)) return "child_safety";
  if (/sexual|nudity|explicit|khiêu dâm|tình dục/.test(normalized)) return "sexual_content";
  if (/weapon|gun|knife|vũ khí|súng|dao/.test(normalized)) return "weapons";
  if (/violence|violent|gore|blood|bạo lực|máu me/.test(normalized)) return "violence";
  if (/dangerous|illegal activity|nguy hiểm|phi pháp/.test(normalized)) return "dangerous_activity";
  return null;
}

function normalizedPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function isInsideDirectory(path: string, directory: string): boolean {
  const candidate = normalizedPath(path);
  const root = normalizedPath(directory);
  return candidate === root || candidate.startsWith(`${root}${sep.toLocaleLowerCase()}`);
}

function generatedMediaRootFromPath(path: string): string | null {
  const storageFolder = STORAGE_FOLDER_NAME.toLocaleLowerCase("en-US");
  let current = dirname(resolve(path));
  while (dirname(current) !== current) {
    if (
      basename(current).toLocaleLowerCase() === "outputs" &&
      basename(dirname(current)).toLocaleLowerCase() === storageFolder
    ) return current;
    if (basename(current).toLocaleLowerCase() === storageFolder) return current;
    current = dirname(current);
  }
  return null;
}

function validateGeneratedMediaRoot(path: string): string {
  const root = resolve(path);
  const storageFolder = STORAGE_FOLDER_NAME.toLocaleLowerCase("en-US");
  const name = basename(root).toLocaleLowerCase();
  const isLegacyRoot = name === storageFolder;
  const isOutputRoot = name === "outputs";
  if ((!isLegacyRoot && !isOutputRoot) || dirname(root) === root) {
    throw new Error(`Thư mục kết quả không an toàn để xóa: ${root}`);
  }
  return root;
}

async function countFilesInDirectory(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFilesInDirectory(join(path, entry.name));
    } else {
      count += 1;
    }
  }
  return count;
}

async function removeGeneratedPathWithRetry(path: string, recursive = false): Promise<void> {
  const retryable = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || "";
      if (code === "ENOENT") return;
      lastError = error;
      if (!retryable.has(code) || attempt === 7) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150 * (attempt + 1)));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`File vẫn đang được Chrome/Flow sử dụng nên chưa thể xóa: ${path}. ${detail}`);
}

export class ProductionQueue {
  private readonly repositories: ProjectRepositories;
  private readonly retryBackoffMs: number[];
  private readonly maxAttempts: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly disconnectedPollMs: number;
  private activeJobId: string | null = null;
  private readonly activeJobIds = new Set<string>();
  private activeProjectId = DEFAULT_PROJECT_ID;
  private readonly projectRuntimes = new Map<string, ProjectQueueRuntime>();
  private pumpTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly forcedErrors = new Map<string, StoredQueueError>();
  private readonly extractLastFrame: (videoPath: string, outputPath: string) => Promise<void>;
  private readonly generatedMediaRoot: string | null;
  private readonly getTextProvider: () => TextProvider | Promise<TextProvider>;
  private defaultImageProvider: ImageGenerationProvider;
  private defaultVideoProvider: VideoGenerationProvider;
  private readonly stoppingJobIds = new Set<string>();
  private shutdownRequested = false;

  constructor(
    private readonly database: ProjectDatabase,
    private readonly worker: QueueWorker,
    private readonly characterStore: CharacterStore,
    private readonly sessionStore: TimelineSessionStore,
    private readonly onChanged: (snapshot: ProductionQueueSnapshot) => void = () => {},
    options: QueueOptions = {},
  ) {
    this.repositories = new ProjectRepositories(database);
    this.retryBackoffMs = options.retryBackoffMs || [2_000, 8_000, 20_000];
    this.maxAttempts = options.maxAttempts || 3;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 45_000;
    this.watchdogIntervalMs = options.watchdogIntervalMs || 5_000;
    this.disconnectedPollMs = options.disconnectedPollMs || 1_000;
    this.extractLastFrame = options.extractLastFrame || runFfmpegLastFrame;
    this.generatedMediaRoot = options.generatedMediaRoot
      ? validateGeneratedMediaRoot(options.generatedMediaRoot)
      : null;
    this.getTextProvider = options.getTextProvider || (() => "chatgpt");
    this.defaultImageProvider = normalizeImageGenerationProvider(options.defaultImageProvider);
    this.defaultVideoProvider = normalizeVideoGenerationProvider(options.defaultVideoProvider);
  }

  async start(): Promise<void> {
    this.shutdownRequested = false;
    const recovered = this.repositories.jobs.recoverRunning();
    for (const job of recovered) {
      const mediaType = jobMediaType(job.jobType);
      if (!job.sceneId || !mediaType) continue;
      const scene = this.repositories.scenes.get(job.sceneId);
      if (!scene) continue;
      const queuedState = mediaType === "image" ? "image_queued" : "video_queued";
      this.repositories.scenes.updateState({
        sceneId: scene.id,
        to: queuedState,
        error: null,
        allowRecovery: true,
      });
      this.activeProjectId = job.projectId;
    }
    for (const project of this.repositories.projects.list()) {
      for (const job of this.repositories.jobs.listRetryableFailures(project.id)) {
        const error = parseError(job.lastError);
        if (error?.retryable) this.scheduleRetry(job, project.id, true);
      }
    }
    for (const project of this.repositories.projects.list()) {
      const runtime = this.runtime(project.id);
      if (this.hasQueuedJobs(project.id)) {
        const persistedState = this.persistedState(project.id);
        runtime.state = persistedState === "paused" || persistedState === "stopped"
          ? persistedState
          : "running";
      } else {
        runtime.state = "idle";
      }
      this.persistState(project.id);
    }
    this.watchdogTimer = setInterval(() => this.checkHeartbeat(), this.watchdogIntervalMs);
    this.emitChanged();
    this.schedulePump(0);
  }

  shutdown(): void {
    this.shutdownRequested = true;
    for (const runtime of this.projectRuntimes.values()) runtime.resumeRepairPending = false;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.pumpTimer = null;
    this.watchdogTimer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  getSnapshot(projectId = this.activeProjectId): ProductionQueueSnapshot {
    const project = this.repositories.projects.get(projectId);
    const scenes = this.repositories.scenes.listByProject(projectId);
    const jobs = this.repositories.jobs.listByProject(projectId);
    const activeJobs = this.activeJobRecords(projectId);
    const active = activeJobs[0] || null;
    const sceneOrder = new Map(scenes.map((scene) => [scene.id, scene.orderIndex]));
    const latestJobIds = new Map<string, string>();
    for (const job of jobs) {
      latestJobIds.set(`${job.sceneId || "project"}:${job.jobType}`, job.id);
    }
    return {
      projectId,
      state: this.runtime(projectId).state,
      activeJobId: active?.id || "",
      activeSceneId: publicSceneId(projectId, active?.sceneId || null),
      activeMediaType: active ? jobMediaType(active.jobType) : null,
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        sceneId: publicSceneId(projectId, job.sceneId),
        jobType: job.jobType,
        mediaType: jobMediaType(job.jobType),
        status: job.status,
        dependsOn: job.dependsOn || "",
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        workerRole: this.workerRoleForJob(job) || "",
      })),
      queuedJobs: jobs.filter((job) => job.status === "queued").length,
      imageProvider: this.getImageProvider(projectId),
      videoProvider: this.getVideoProvider(projectId),
      autoApproveImages: project?.autoApproveImages || false,
      autoApproveVideos: project?.autoApproveVideos || false,
      scenes: scenes.map((scene) => ({
        sceneId: publicSceneId(projectId, scene.id),
        orderIndex: scene.orderIndex,
        status: scene.status,
        imageAssetPath: scene.imageAssetPath || "",
        startFrameAssetPath: scene.startFrameAssetPath || "",
        flowImageAssetId: scene.flowImageAssetId || "",
        videoAssetPath: scene.videoAssetPath || "",
        approvedImage: scene.approvedImage,
        approvedVideo: scene.approvedVideo,
        lastError: parseError(scene.lastError)?.message || scene.lastError || "",
      })),
      jobs: jobs.map((job) => ({
        id: job.id,
        sceneId: publicSceneId(projectId, job.sceneId),
        jobType: job.jobType,
        mediaType: jobMediaType(job.jobType),
        status: job.status,
        dependsOn: job.dependsOn || "",
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      })),
      errors: jobs.flatMap((job) => {
        if (
          job.status !== "failed" ||
          !job.sceneId ||
          latestJobIds.get(`${job.sceneId}:${job.jobType}`) !== job.id
        ) return [];
        const parsed = parseError(job.lastError);
        const mediaType = jobMediaType(job.jobType);
        if (!parsed || !mediaType) return [];
        return [{
          jobId: job.id,
          sceneId: publicSceneId(projectId, job.sceneId),
          orderIndex: sceneOrder.get(job.sceneId) ?? -1,
          mediaType,
          category: parsed.category,
          message: parsed.message,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          retryable: parsed.retryable && job.attempts < job.maxAttempts,
          updatedAt: job.updatedAt,
        }];
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  async generateAllImages(
    projectId = DEFAULT_PROJECT_ID,
    options: QueueGenerateOptions = {},
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    if (options.imageProvider) {
      this.repositories.metadata.set(
        this.imageProviderMetadataKey(projectId),
        normalizeImageGenerationProvider(options.imageProvider),
      );
    }
    await this.repairContinuationDependencies(projectId, options.fromSceneIndex || 0);
    const automaticPipeline = Boolean(this.repositories.projects.get(projectId)?.autoApproveImages);
    if (automaticPipeline) await this.resetPendingAutomaticPipeline(projectId);
    const statuses = new Set<SceneState>(options.onlyStatuses || ["prompt_ready", "image_failed"]);
    for (const scene of this.repositories.scenes.listByProject(projectId)) {
      if (scene.orderIndex < (options.fromSceneIndex || 0) || !statuses.has(scene.status)) continue;
      // Continuations no longer synthesize a separate still image. The exact
      // last frame of the preceding clip becomes their approved opening image
      // and is attached directly to Flow's Start frame slot.
      if (scene.chainRole === "continue") {
        if (scene.startFrameAssetPath) {
          const continued = this.repositories.scenes.useContinuationFrameAsOpeningImage(
            scene.id,
            scene.startFrameAssetPath,
          );
          if (automaticPipeline) this.enqueueScene(continued, "video");
        }
        continue;
      }
      this.enqueueScene(scene, "image");
    }
    if (automaticPipeline) {
      for (const scene of this.repositories.scenes.listByProject(projectId)) {
        if (scene.orderIndex < (options.fromSceneIndex || 0) || !scene.imageAssetPath) continue;
        if (scene.status === "image_done") {
          const approved = this.repositories.scenes.updateState({
            sceneId: scene.id,
            to: "image_approved",
            approvedImage: true,
            error: null,
          });
          this.enqueueScene(approved, "video");
        } else if (scene.status === "image_approved") {
          this.enqueueScene(scene, "video");
        }
      }
    }
    return this.run(projectId);
  }

  async generateAllVideos(
    projectId = DEFAULT_PROJECT_ID,
    options: QueueVideoOptions = { onlyApprovedImages: true, delivery: "submit-only" },
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    if (options.videoProvider) {
      this.repositories.metadata.set(
        this.videoProviderMetadataKey(projectId),
        normalizeVideoGenerationProvider(options.videoProvider),
      );
    }
    const directVideo = options.videoMode === "text-to-video" || options.onlyApprovedImages === false;
    if (!directVideo) {
      await this.repairContinuationDependencies(projectId, options.fromSceneIndex || 0);
    } else {
      this.removePendingJobsForDirectVideo(projectId, options.fromSceneIndex || 0);
    }
    const statuses = new Set<SceneState>(
      options.onlyStatuses || (directVideo
        ? ["prompt_ready", "image_done", "image_failed", "image_approved", "video_failed"]
        : ["image_approved", "video_failed"]),
    );
    for (const scene of this.repositories.scenes.listByProject(projectId)) {
      if (scene.orderIndex < (options.fromSceneIndex || 0) || !statuses.has(scene.status)) continue;
      const submittedMode = scene.status === "video_submitted"
        ? this.latestVideoJobMode(scene.id)
        : null;
      const videoMode: VideoJobMode = submittedMode || (directVideo ? "direct" : "image-first");
      if (videoMode !== "direct" && scene.chainRole !== "continue" && options.onlyApprovedImages !== false && (!scene.approvedImage || !scene.imageAssetPath)) {
        continue;
      }
      this.enqueueScene(scene, "video", null, videoMode, options.delivery || "submit-only");
    }
    return this.run(projectId);
  }

  pauseQueue(projectId = this.activeProjectId): ProductionQueueSnapshot {
    const runtime = this.runtime(projectId);
    runtime.state = "paused";
    if (runtime.singleRunJobId) runtime.stateAfterSingleRun = "paused";
    this.persistState(projectId);
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  resumeQueue(projectId = this.activeProjectId): ProductionQueueSnapshot {
    const runtime = this.runtime(projectId);
    runtime.state = "running";
    this.persistState(projectId);
    this.emitChanged(projectId);
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    runtime.resumeRepairPending = true;
    void (async () => {
      if (this.shutdownRequested || runtime.state !== "running") return;
      const directVideoProject = await this.isDirectVideoProject(projectId);
      if (this.shutdownRequested || runtime.state !== "running") return;
      if (!directVideoProject) {
        await this.repairContinuationDependencies(projectId);
      }
    })().catch((error) => {
      if (!this.shutdownRequested) {
        console.warn("Failed to repair continuation dependencies while resuming queue", error);
      }
    }).finally(() => {
      runtime.resumeRepairPending = false;
      if (!this.shutdownRequested && runtime.state === "running") this.schedulePump(50);
    });
    return this.getSnapshot(projectId);
  }

  stopQueue(projectId = this.activeProjectId): ProductionQueueSnapshot {
    const runtime = this.runtime(projectId);
    runtime.state = "stopped";
    runtime.singleRunJobId = null;
    runtime.singleRunSceneIds.clear();
    runtime.stateAfterSingleRun = null;
    runtime.resumeRepairPending = false;
    this.persistState(projectId);
    for (const active of this.activeJobRecords(projectId)) {
      const role = this.workerRoleForJob(active);
      if (!role) continue;
      this.stoppingJobIds.add(active.id);
      this.worker.stopActiveJob(role, active.id);
    }
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  async clearGeneratedMedia(
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ClearGeneratedMediaResult> {
    this.activeProjectId = projectId;
    this.stopQueue(projectId);
    const stopDeadline = Date.now() + 15_000;
    while (this.hasActiveJobs(projectId) && Date.now() < stopDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (this.hasActiveJobs(projectId)) {
      throw new Error("Job hiện tại chưa dừng xong. Chưa xóa bất kỳ kết quả nào; hãy thử lại sau vài giây.");
    }

    await this.syncProject(projectId);
    const scenes = this.repositories.scenes.listByProject(projectId);
    const trackedPaths = [...new Set(scenes.flatMap((scene) => [
      scene.startFrameAssetPath,
      scene.imageAssetPath,
      scene.videoAssetPath,
    ]).filter((path): path is string => Boolean(path?.trim())))];

    // A stale renderer snapshot from an older workspace may reference the same
    // legacy flat file. Never delete a path still owned by another workspace.
    const sharedPathKeys = new Set<string>();
    const otherRows = this.database.db.prepare(`
      SELECT start_frame_asset_path, image_asset_path, video_asset_path
      FROM scenes WHERE project_id <> ?
    `).all(projectId) as Array<Record<string, unknown>>;
    for (const row of otherRows) {
      for (const value of [row.start_frame_asset_path, row.image_asset_path, row.video_asset_path]) {
        if (typeof value === "string" && value.trim()) sharedPathKeys.add(normalizedPath(value));
      }
    }
    for (const summary of await this.sessionStore.list()) {
      if (summary.id === projectId) continue;
      const otherSession = await this.sessionStore.load(summary.id);
      for (const scene of otherSession?.scenes || []) {
        for (const value of [scene.imageResultPath, scene.videoResultPath]) {
          if (value?.trim()) sharedPathKeys.add(normalizedPath(value));
        }
      }
    }
    const deletablePaths = trackedPaths.filter((path) => !sharedPathKeys.has(normalizedPath(path)));

    const roots = new Map<string, string>();
    if (this.generatedMediaRoot) {
      roots.set(normalizedPath(this.generatedMediaRoot), this.generatedMediaRoot);
    }
    for (const path of deletablePaths) {
      const root = generatedMediaRootFromPath(path);
      if (root) roots.set(normalizedPath(root), validateGeneratedMediaRoot(root));
    }

    for (const path of trackedPaths) {
      const insideKnownRoot = [...roots.values()].some((root) => isInsideDirectory(path, root));
      if (insideKnownRoot) continue;
      const exists = await access(path).then(() => true, () => false);
      if (exists) {
        throw new Error(
          `Không xóa vì file kết quả nằm ngoài thư mục ${APP_BRAND_NAME}: ${path}`,
        );
      }
    }

    let deletedFiles = 0;
    let deletedDirectories = 0;
    const deletedDirectoryPaths: string[] = [];
    const project = this.repositories.projects.get(projectId);
    if (this.generatedMediaRoot && project) {
      const projectDirectory = join(
        this.generatedMediaRoot,
        projectOutputFolder(project.id, project.name),
      );
      const sharedInsideProjectDirectory = [...sharedPathKeys].some((path) =>
        isInsideDirectory(path, projectDirectory)
      );
      const exists = await access(projectDirectory).then(() => true, () => false);
      if (exists && !sharedInsideProjectDirectory) {
        deletedFiles += await countFilesInDirectory(projectDirectory);
        await removeGeneratedPathWithRetry(projectDirectory, true);
        deletedDirectories += 1;
        deletedDirectoryPaths.push(projectDirectory);
      }
    }
    const deletedFileKeys = new Set<string>();
    for (const path of deletablePaths) {
      if (deletedDirectoryPaths.some((directory) => isInsideDirectory(path, directory))) continue;
      const exists = await access(path).then(() => true, () => false);
      if (!exists) continue;
      await removeGeneratedPathWithRetry(path);
      deletedFiles += 1;
      deletedFileKeys.add(normalizedPath(path));
    }

    const session = await this.sessionStore.load(projectId);
    if (!session?.scenes.length) {
      throw new Error("Không còn kết quả Phase 3 để giữ lại.");
    }
    await this.sessionStore.save({
      visualBible: session.visualBible,
      styleReference: session.styleReference,
      scenes: session.scenes.map((scene) => ({
        ...scene,
        imageStatus: "pending" as const,
        imageResultPath: "",
        imageFlowAssetKey: "",
        imageApproved: false,
        videoStatus: "pending" as const,
        videoResultPath: "",
        videoApproved: false,
      })),
    }, projectId);

    const projectJobIds = new Set(this.repositories.jobs.listByProject(projectId).map((job) => job.id));
    this.database.transaction(() => {
      this.database.db.prepare("DELETE FROM jobs WHERE project_id = ?").run(projectId);
      this.database.db.prepare(`
        UPDATE scenes SET
          start_frame_asset_path = NULL,
          status = 'prompt_ready',
          image_asset_path = NULL,
          flow_image_asset_id = NULL,
          video_asset_path = NULL,
          approved_image = 0,
          approved_video = 0,
          last_error = NULL,
          updated_at = ?
        WHERE project_id = ?
      `).run(now(), projectId);
      for (const bible of this.repositories.visualBibles.listByProject(projectId)) {
        const retainedAnchors = bible.anchorImagePaths.filter((path) =>
          !deletedFileKeys.has(normalizedPath(path)) &&
          !deletedDirectoryPaths.some((directory) => isInsideDirectory(path, directory))
        );
        this.repositories.visualBibles.setAnchors(bible.id, retainedAnchors, bible.locked);
      }
      this.repositories.projects.setApprovalPolicy(projectId, false, false);
    });

    this.cancelRetriesForProject(projectId, projectJobIds);
    this.clearForcedErrorsForProject(projectId, projectJobIds);
    this.clearActiveJobsForProject(projectId, projectJobIds);
    this.clearStoppingJobsForProject(projectId, projectJobIds);
    this.resetProjectRuntime(projectId, "idle");
    this.persistState(projectId);
    this.emitChanged(projectId);
    return {
      snapshot: this.getSnapshot(projectId),
      deletedFiles,
      deletedDirectories,
      retainedScenes: scenes.length,
    };
  }

  async clearSceneMedia(
    sceneId: string,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ClearSceneMediaResult> {
    this.activeProjectId = projectId;
    this.stopQueue(projectId);
    const stopDeadline = Date.now() + 15_000;
    while (this.hasActiveJobs(projectId) && Date.now() < stopDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (this.hasActiveJobs(projectId)) {
      throw new Error("Job hiện tại chưa dừng xong. Scene chưa bị xóa; hãy thử lại sau vài giây.");
    }

    await this.syncProject(projectId);
    const scene = this.requireScene(projectId, sceneId);
    const publicId = publicSceneId(projectId, scene.id);
    const session = await this.sessionStore.load(projectId);
    if (!session?.scenes.some((storedScene) => storedScene.id === publicId)) {
      throw new Error(`Không tìm thấy scene ${publicId} trong phiên Phase 3.`);
    }
    const trackedPaths = [...new Set([
      scene.startFrameAssetPath,
      scene.imageAssetPath,
      scene.videoAssetPath,
    ].filter((path): path is string => Boolean(path?.trim())))];

    const sharedPathKeys = new Set<string>();
    const otherRows = this.database.db.prepare(`
      SELECT start_frame_asset_path, image_asset_path, video_asset_path
      FROM scenes WHERE id <> ?
    `).all(scene.id) as Array<Record<string, unknown>>;
    for (const row of otherRows) {
      for (const value of [row.start_frame_asset_path, row.image_asset_path, row.video_asset_path]) {
        if (typeof value === "string" && value.trim()) sharedPathKeys.add(normalizedPath(value));
      }
    }
    for (const summary of await this.sessionStore.list()) {
      const session = await this.sessionStore.load(summary.id);
      for (const storedScene of session?.scenes || []) {
        if (summary.id === projectId && storedScene.id === publicId) continue;
        for (const value of [storedScene.imageResultPath, storedScene.videoResultPath]) {
          if (value?.trim()) sharedPathKeys.add(normalizedPath(value));
        }
      }
    }
    const deletablePaths = trackedPaths.filter((path) => !sharedPathKeys.has(normalizedPath(path)));
    const roots = new Map<string, string>();
    if (this.generatedMediaRoot) roots.set(normalizedPath(this.generatedMediaRoot), this.generatedMediaRoot);
    for (const path of deletablePaths) {
      const root = generatedMediaRootFromPath(path);
      if (root) roots.set(normalizedPath(root), validateGeneratedMediaRoot(root));
    }
    for (const path of deletablePaths) {
      const insideKnownRoot = [...roots.values()].some((root) => isInsideDirectory(path, root));
      if (insideKnownRoot) continue;
      const exists = await access(path).then(() => true, () => false);
      if (exists) throw new Error(`Không xóa vì file kết quả nằm ngoài thư mục ${APP_BRAND_NAME}: ${path}`);
    }

    let deletedFiles = 0;
    for (const path of deletablePaths) {
      const exists = await access(path).then(() => true, () => false);
      if (!exists) continue;
      await removeGeneratedPathWithRetry(path);
      deletedFiles += 1;
    }

    await this.sessionStore.save({
      visualBible: session.visualBible,
      styleReference: session.styleReference,
      scenes: session.scenes.map((storedScene) => storedScene.id === publicId
        ? {
            ...storedScene,
            imageStatus: "pending" as const,
            imageResultPath: "",
            imageFlowAssetKey: "",
            imageApproved: false,
            videoStatus: "pending" as const,
            videoResultPath: "",
            videoApproved: false,
          }
        : storedScene),
    }, projectId);

    const affectedJobs = this.database.db.prepare(`
      WITH RECURSIVE affected(id, scene_id) AS (
        SELECT id, scene_id FROM jobs WHERE scene_id = ?
        UNION ALL
        SELECT child.id, child.scene_id
        FROM jobs child JOIN affected parent ON child.depends_on = parent.id
      )
      SELECT DISTINCT id, scene_id FROM affected
    `).all(scene.id) as Array<{ id: string; scene_id: string }>;
    for (const job of affectedJobs) {
      this.cancelRetry(job.id);
      this.forcedErrors.delete(job.id);
    }
    this.database.transaction(() => {
      this.database.db.prepare(`
        WITH RECURSIVE affected(id) AS (
          SELECT id FROM jobs WHERE scene_id = ?
          UNION ALL
          SELECT child.id FROM jobs child JOIN affected parent ON child.depends_on = parent.id
        )
        DELETE FROM jobs WHERE id IN (SELECT id FROM affected)
      `).run(scene.id);
      this.database.db.prepare(`
        UPDATE scenes SET
          start_frame_asset_path = NULL,
          status = 'prompt_ready',
          image_asset_path = NULL,
          flow_image_asset_id = NULL,
          video_asset_path = NULL,
          approved_image = 0,
          approved_video = 0,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(now(), scene.id);
      for (const dependentSceneId of new Set(affectedJobs.map((job) => job.scene_id))) {
        if (dependentSceneId !== scene.id) this.repositories.scenes.resetPendingQueueState(dependentSceneId);
      }
      for (const bible of this.repositories.visualBibles.listByProject(projectId)) {
        const retainedAnchors = bible.anchorImagePaths.filter((path) =>
          !deletablePaths.some((deletedPath) => normalizedPath(deletedPath) === normalizedPath(path))
        );
        this.repositories.visualBibles.setAnchors(bible.id, retainedAnchors, bible.locked);
      }
    });

    const affectedJobIds = new Set(affectedJobs.map((job) => job.id));
    this.clearActiveJobsForProject(projectId, affectedJobIds);
    this.clearStoppingJobsForProject(projectId, affectedJobIds);
    this.resetProjectRuntime(projectId, "stopped");
    this.persistState(projectId);
    this.emitChanged(projectId);
    return {
      snapshot: this.getSnapshot(projectId),
      sceneId: publicId,
      deletedFiles,
    };
  }

  async retryFailed(
    sceneIds: string[],
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    const requested = new Set(sceneIds.map((id) => this.resolveSceneId(projectId, id)));
    const failures = this.repositories.jobs.listByProject(projectId)
      .filter((job) => job.status === "failed" && job.sceneId && (!requested.size || requested.has(job.sceneId)));
    const latest = new Map<string, JobRecord>();
    for (const job of failures) latest.set(`${job.sceneId}:${job.jobType}`, job);
    for (const job of latest.values()) {
      if (!job.sceneId) continue;
      this.cancelRetry(job.id);
      const mediaType = jobMediaType(job.jobType);
      if (!mediaType) continue;
      const scene = this.repositories.scenes.resetForMedia(job.sceneId, mediaType);
      this.enqueueScene(scene, mediaType, null, videoJobMode(job.jobType), videoJobDelivery(job.jobType));
    }
    return this.run(projectId);
  }

  async resumeFrom(
    sceneId: string,
    mediaType: SceneMediaType,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    const target = this.requireScene(projectId, sceneId);
    const session = mediaType === "video" ? await this.sessionStore.load(projectId) : null;
    const directVideo = mediaType === "video" && (
      (session?.workflowSource.sourceKind === "script" &&
        (session.workflowSource.outputTarget || "video") === "video" &&
        (session.workflowSource.videoSourceMode || "direct") === "direct")
    );
    return mediaType === "image"
      ? this.generateAllImages(projectId, {
        fromSceneIndex: target.orderIndex,
        onlyStatuses: ["prompt_ready", "image_failed"],
      })
      : this.generateAllVideos(projectId, {
        fromSceneIndex: target.orderIndex,
        onlyStatuses: directVideo ? ["prompt_ready", "image_done", "image_failed", "image_approved", "video_failed"] : ["image_approved", "video_failed"],
        onlyApprovedImages: !directVideo,
        videoMode: directVideo ? "text-to-video" : "first-frame",
        delivery: directVideo ? session?.workflowSource.directVideoDelivery || "download" : "download",
      });
  }

  async regenerateScene(
    sceneId: string,
    mediaType: SceneMediaType,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ProductionQueueSnapshot> {
    if (this.hasActiveJobs(projectId)) {
      this.stopQueue(projectId);
      const deadline = Date.now() + 15_000;
      while (this.hasActiveJobs(projectId) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (this.hasActiveJobs(projectId)) {
        throw new Error("Job hiện tại chưa dừng xong; chưa xóa kết quả cũ để tạo lại.");
      }
    }
    await this.syncProject(projectId);
    const scene = this.requireScene(projectId, sceneId);
    if (scene.chainRole === "continue" && mediaType === "image") {
      throw new Error("Scene tiếp nối dùng frame cuối của video trước, không tạo lại ảnh riêng. Hãy tạo lại video trước hoặc video của scene này.");
    }
    const session = await this.sessionStore.load(projectId);
    const targetPublicId = publicSceneId(projectId, scene.id);
    if (!session?.scenes.some((storedScene) => storedScene.id === targetPublicId)) {
      throw new Error(`Không tìm thấy ${targetPublicId} trong phiên Phase 3.`);
    }
    const directRegenerateVideo = mediaType === "video" &&
      session.workflowSource.sourceKind === "script" &&
      (session.workflowSource.outputTarget || "video") === "video" &&
      (session.workflowSource.videoSourceMode || "direct") === "direct";

    const projectScenes = this.repositories.scenes.listByProject(projectId);
    const continuationScenes: SceneRecord[] = [];
    if (!directRegenerateVideo && scene.chainId) {
      for (let orderIndex = scene.orderIndex + 1; ; orderIndex += 1) {
        const next = projectScenes.find((candidate) => candidate.orderIndex === orderIndex);
        if (!next || next.chainRole !== "continue" || next.chainId !== scene.chainId) break;
        continuationScenes.push(next);
      }
    }
    const invalidatedScenes = [scene, ...continuationScenes];
    const invalidatedIds = new Set(invalidatedScenes.map((entry) => entry.id));
    const pathsToDelete = invalidatedScenes.flatMap((entry) => {
      if (entry.id === scene.id && mediaType === "video") {
        return entry.videoAssetPath ? [entry.videoAssetPath] : [];
      }
      return [entry.startFrameAssetPath, entry.imageAssetPath, entry.videoAssetPath]
        .filter((path): path is string => Boolean(path?.trim()));
    });
    const deletedPathKeys = await this.removeGeneratedPathsForReplacement(
      projectId,
      invalidatedIds,
      pathsToDelete,
    );

    const invalidatedPublicIds = new Set(
      invalidatedScenes.map((entry) => publicSceneId(projectId, entry.id)),
    );
    await this.sessionStore.save({
      visualBible: session.visualBible,
      styleReference: session.styleReference,
      scenes: session.scenes.map((storedScene) => {
        if (!invalidatedPublicIds.has(storedScene.id)) return storedScene;
        if (storedScene.id === targetPublicId && mediaType === "video") {
          return {
            ...storedScene,
            videoStatus: "pending" as const,
            videoResultPath: "",
            videoApproved: false,
          };
        }
        return {
          ...storedScene,
          imageStatus: "pending" as const,
          imageResultPath: "",
          imageFlowAssetKey: "",
          imageApproved: false,
          videoStatus: "pending" as const,
          videoResultPath: "",
          videoApproved: false,
        };
      }),
    }, projectId);

    const allJobs = this.repositories.jobs.listByProject(projectId);
    const removedJobIds = new Set(
      allJobs.filter((job) => job.sceneId && invalidatedIds.has(job.sceneId)).map((job) => job.id),
    );
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const job of allJobs) {
        if (removedJobIds.has(job.id) || !job.dependsOn || !removedJobIds.has(job.dependsOn)) continue;
        removedJobIds.add(job.id);
        expanded = true;
      }
    }
    for (const jobId of removedJobIds) {
      this.cancelRetry(jobId);
      this.forcedErrors.delete(jobId);
    }
    const affectedJobSceneIds = new Set(
      allJobs.filter((job) => removedJobIds.has(job.id) && job.sceneId).map((job) => job.sceneId!),
    );
    this.database.transaction(() => {
      if (removedJobIds.size > 0) {
        const placeholders = [...removedJobIds].map(() => "?").join(", ");
        this.database.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...removedJobIds);
      }
      for (const continued of continuationScenes) {
        this.database.db.prepare(`
          UPDATE scenes SET
            start_frame_asset_path = NULL,
            status = 'prompt_ready',
            image_asset_path = NULL,
            flow_image_asset_id = NULL,
            video_asset_path = NULL,
            approved_image = 0,
            approved_video = 0,
            last_error = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(now(), continued.id);
      }
      for (const affectedSceneId of affectedJobSceneIds) {
        if (!invalidatedIds.has(affectedSceneId)) {
          this.repositories.scenes.resetPendingQueueState(affectedSceneId);
        }
      }
      for (const bible of this.repositories.visualBibles.listByProject(projectId)) {
        const retainedAnchors = bible.anchorImagePaths.filter((path) =>
          !deletedPathKeys.has(normalizedPath(path))
        );
        this.repositories.visualBibles.setAnchors(bible.id, retainedAnchors, bible.locked);
      }
    });
    const reset = this.repositories.scenes.resetForMedia(scene.id, mediaType);
    const job = this.enqueueScene(
      reset,
      mediaType,
      null,
      mediaType === "video" && directRegenerateVideo ? "direct" : "image-first",
    );
    const runtime = this.runtime(projectId);
    if (runtime.state === "stopped" || runtime.state === "paused") {
      this.activeProjectId = projectId;
      runtime.singleRunJobId = job.id;
      runtime.singleRunSceneIds.clear();
      for (const entry of invalidatedScenes) runtime.singleRunSceneIds.add(entry.id);
      runtime.stateAfterSingleRun = runtime.state;
      runtime.state = "running";
      this.persistState(projectId);
      this.emitChanged(projectId);
      this.schedulePump(0);
      return this.getSnapshot(projectId);
    }
    return this.run(projectId);
  }

  async approveScene(
    sceneId: string,
    mediaType: SceneMediaType,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    const scene = this.requireScene(projectId, sceneId);
    if (mediaType === "image") {
      if (!scene.imageAssetPath) throw new Error("Scene chưa có ảnh để duyệt");
      const downstreamStates: SceneState[] = [
        "video_queued",
        "video_generating",
        "video_done",
        "video_failed",
        "video_approved",
      ];
      const targetState = downstreamStates.includes(scene.status)
        ? scene.status
        : scene.status === "image_done" || scene.status === "needs_review" || scene.status === "image_approved"
          ? "image_approved"
          : null;
      if (!targetState) {
        throw new Error(`Ảnh chưa sẵn sàng để duyệt (trạng thái hiện tại: ${scene.status})`);
      }
      this.repositories.scenes.updateState({
        sceneId: scene.id,
        to: targetState,
        approvedImage: true,
        error: null,
      });
    } else {
      if (!scene.videoAssetPath) throw new Error("Scene chưa có video để duyệt");
      const targetState = scene.status === "video_done" ||
        scene.status === "needs_review" ||
        scene.status === "video_approved"
        ? "video_approved"
        : null;
      if (!targetState) {
        throw new Error(`Video chưa sẵn sàng để duyệt (trạng thái hiện tại: ${scene.status})`);
      }
      this.repositories.scenes.updateState({
        sceneId: scene.id,
        to: targetState,
        approvedVideo: true,
        error: null,
      });
    }
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  async rejectScene(
    sceneId: string,
    mediaType: SceneMediaType,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ProductionQueueSnapshot> {
    await this.syncProject(projectId);
    const scene = this.requireScene(projectId, sceneId);
    const expected: SceneState[] = mediaType === "image"
      ? ["image_done", "image_approved"]
      : ["video_done", "video_approved"];
    if (!expected.includes(scene.status)) {
      throw new Error(
        `${mediaType === "image" ? "Ảnh" : "Video"} chưa ở trạng thái có thể từ chối (hiện tại: ${scene.status})`,
      );
    }
    this.repositories.scenes.updateState({
      sceneId: scene.id,
      to: "needs_review",
      approvedImage: mediaType === "image" ? false : scene.approvedImage,
      approvedVideo: mediaType === "video" ? false : scene.approvedVideo,
      error: "Người dùng yêu cầu xem lại kết quả",
    });
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  setApprovalPolicy(
    images: boolean,
    videos: boolean,
    projectId = DEFAULT_PROJECT_ID,
  ): ProductionQueueSnapshot {
    if (!this.repositories.projects.get(projectId)) {
      this.repositories.projects.create({
        id: projectId,
        name: `Dự án ${APP_BRAND_NAME} hiện tại`,
      });
    }
    this.repositories.projects.setApprovalPolicy(projectId, images, videos);
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  setImageProvider(
    provider: ImageGenerationProvider,
    projectId = DEFAULT_PROJECT_ID,
  ): ProductionQueueSnapshot {
    this.ensureProject(projectId);
    this.repositories.metadata.set(
      this.imageProviderMetadataKey(projectId),
      normalizeImageGenerationProvider(provider),
    );
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  setVideoProvider(
    provider: VideoGenerationProvider,
    projectId = DEFAULT_PROJECT_ID,
  ): ProductionQueueSnapshot {
    this.ensureProject(projectId);
    this.repositories.metadata.set(
      this.videoProviderMetadataKey(projectId),
      normalizeVideoGenerationProvider(provider),
    );
    this.emitChanged(projectId);
    return this.getSnapshot(projectId);
  }

  setDefaultProviders(
    imageProvider: ImageGenerationProvider,
    videoProvider: VideoGenerationProvider,
  ): void {
    this.defaultImageProvider = normalizeImageGenerationProvider(imageProvider);
    this.defaultVideoProvider = normalizeVideoGenerationProvider(videoProvider);
    this.emitChanged();
  }

  private ensureProject(projectId: string): void {
    if (!this.repositories.projects.get(projectId)) {
      this.repositories.projects.create({
        id: projectId,
        name: `Dự án ${APP_BRAND_NAME} hiện tại`,
      });
    }
  }

  private imageProviderMetadataKey(projectId: string): string {
    return `${IMAGE_PROVIDER_METADATA_PREFIX}${projectId}`;
  }

  private getImageProvider(projectId: string): ImageGenerationProvider {
    const stored = this.repositories.metadata.get(this.imageProviderMetadataKey(projectId));
    return stored == null
      ? this.defaultImageProvider
      : normalizeImageGenerationProvider(stored);
  }

  private videoProviderMetadataKey(projectId: string): string {
    return `${VIDEO_PROVIDER_METADATA_PREFIX}${projectId}`;
  }

  private getVideoProvider(projectId: string): VideoGenerationProvider {
    const stored = this.repositories.metadata.get(this.videoProviderMetadataKey(projectId));
    return stored == null
      ? this.defaultVideoProvider
      : normalizeVideoGenerationProvider(stored);
  }

  private workerRoleForJob(job: JobRecord): WorkerRole | null {
    const mediaType = jobMediaType(job.jobType);
    if (!mediaType) return null;
    if (mediaType === "image") {
      const provider = this.getImageProvider(job.projectId);
      if (provider === "chatgpt-image") return "chat-worker";
      if (provider === "gemini-image") return "gemini-worker";
      if (provider === "grok-image") return "grok-worker";
      return "flow-worker";
    }
    const provider = this.getVideoProvider(job.projectId);
    if (provider === "gemini-video") return "gemini-worker";
    if (provider === "grok-video") return "grok-worker";
    if (provider === "capcut-video") return "capcut-worker";
    return "flow-worker";
  }

  private activeJobRecords(projectId?: string): JobRecord[] {
    const records: JobRecord[] = [];
    for (const jobId of this.activeJobIds) {
      const job = this.repositories.jobs.get(jobId);
      if (!job || (projectId && job.projectId !== projectId)) continue;
      records.push(job);
    }
    return records.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  private hasActiveJobs(projectId?: string): boolean {
    return this.activeJobRecords(projectId).length > 0;
  }

  private markActiveJob(job: JobRecord): void {
    this.activeJobIds.add(job.id);
    if (!this.activeJobId) this.activeJobId = job.id;
  }

  private clearActiveJob(jobId: string): void {
    this.activeJobIds.delete(jobId);
    this.stoppingJobIds.delete(jobId);
    if (this.activeJobId === jobId) {
      this.activeJobId = this.activeJobIds.values().next().value || null;
    }
  }

  private activeRoleCount(role: WorkerRole): number {
    return this.activeJobRecords().filter((job) => this.workerRoleForJob(job) === role).length;
  }

  private availableSlotsForRole(role: WorkerRole): number {
    const statuses = this.worker.getStatuses();
    if (!statuses[role]?.connected) return 0;
    if (this.worker.getAvailableSlots) return Math.max(0, this.worker.getAvailableSlots(role));
    return this.activeRoleCount(role) > 0 ? 0 : 1;
  }

  private runnableJobs(): JobRecord[] {
    return this.repositories.projects.list()
      .filter((project) => {
        const runtime = this.runtime(project.id);
        return runtime.state === "running" && !runtime.singleRunJobId;
      })
      .flatMap((project) => {
        const scenes = this.repositories.scenes.listByProject(project.id);
        const sceneOrder = new Map(scenes.map((scene) => [scene.id, scene.orderIndex]));
        return this.repositories.jobs.listByProject(project.id)
          .filter((job) => {
            if (job.status !== "queued") return false;
            const dependency = job.dependsOn ? this.repositories.jobs.get(job.dependsOn) : null;
            return !dependency || dependency.status === "succeeded";
          })
          .sort((left, right) =>
            (sceneOrder.get(left.sceneId || "") ?? Number.MAX_SAFE_INTEGER) -
              (sceneOrder.get(right.sceneId || "") ?? Number.MAX_SAFE_INTEGER) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id)
          );
      });
  }

  private async syncProject(projectId: string): Promise<void> {
    const session = await this.sessionStore.load(projectId);
    if (!session?.scenes.length) throw new Error("Chưa có timeline để đưa vào hàng đợi");
    syncTimelineSessionToProject(
      this.database,
      session,
      await this.characterStore.list(),
      projectId,
    );
    this.activeProjectId = projectId;
  }

  private run(projectId: string): ProductionQueueSnapshot {
    this.activeProjectId = projectId;
    const runtime = this.runtime(projectId);
    runtime.singleRunJobId = null;
    runtime.singleRunSceneIds.clear();
    runtime.stateAfterSingleRun = null;
    runtime.resumeRepairPending = false;
    runtime.state = "running";
    this.persistState(projectId);
    this.emitChanged(projectId);
    this.schedulePump(0);
    return this.getSnapshot(projectId);
  }

  private async resetPendingAutomaticPipeline(projectId: string): Promise<void> {
    if (this.hasActiveJobs(projectId)) {
      this.stopQueue(projectId);
      const deadline = Date.now() + 10_000;
      while (this.hasActiveJobs(projectId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.hasActiveJobs(projectId)) {
        throw new Error("Job hiện tại chưa dừng xong; hãy chờ vài giây rồi chạy tự động lại");
      }
    }
    const pending = this.repositories.jobs.listByProject(projectId)
      .filter((job) => job.status === "queued" || job.status === "failed");
    for (const job of pending) this.cancelRetry(job.id);
    this.database.transaction(() => {
      const removed = this.repositories.jobs.removePendingByProject(projectId);
      const sceneIds = [...new Set(removed.flatMap((job) => job.sceneId ? [job.sceneId] : []))];
      for (const sceneId of sceneIds) this.repositories.scenes.resetPendingQueueState(sceneId);
    });
  }

  private enqueueScene(
    scene: SceneRecord,
    mediaType: SceneMediaType,
    dependsOn: string | null = null,
    videoMode: VideoJobMode = "image-first",
    requestedDelivery: VideoDeliveryMode = "submit-only",
  ): JobRecord {
    const delivery = mediaType === "video"
      ? this.resolveVideoDelivery(scene, videoMode, requestedDelivery)
      : "download";
    if (mediaType === "video" && videoMode !== "direct" && scene.chainRole === "continue") {
      dependsOn = this.ensureExtractFrameJob(scene)?.id || dependsOn;
    }
    const jobType = mediaType === "image"
      ? IMAGE_JOB
      : videoMode === "direct"
        ? delivery === "submit-only" ? DIRECT_VIDEO_SUBMIT_JOB : DIRECT_VIDEO_JOB
        : delivery === "submit-only" ? VIDEO_SUBMIT_JOB : VIDEO_JOB;
    const existing = mediaType === "video"
      ? this.repositories.jobs.listByScene(scene.id)
        .filter((job) => isVideoJobType(job.jobType) && (job.status === "queued" || job.status === "running"))
        .at(-1) || null
      : this.repositories.jobs.findActive(scene.id, jobType);
    const queuedState = mediaType === "image" ? "image_queued" : "video_queued";
    if (existing) {
      if (scene.status !== queuedState) {
        this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: queuedState,
          error: null,
        });
      }
      return existing;
    }
    const transitioned = this.repositories.scenes.transition({
      sceneId: scene.id,
      to: queuedState,
      jobType,
      payloadHash: payloadHash(
        scene,
        mediaType,
        this.getImageProvider(scene.projectId),
        this.getVideoProvider(scene.projectId),
        videoMode,
        delivery,
      ),
      maxAttempts: this.maxAttempts,
      dependsOn,
    });
    return transitioned.job;
  }

  private resolveVideoDelivery(
    scene: SceneRecord,
    videoMode: VideoJobMode,
    requestedDelivery: VideoDeliveryMode,
  ): VideoDeliveryMode {
    const provider = this.getVideoProvider(scene.projectId);
    if (provider !== "google-flow") return "download";
    if (requestedDelivery === "download" || videoMode === "direct") return requestedDelivery;
    const next = this.repositories.scenes.listByProject(scene.projectId)
      .find((candidate) => candidate.orderIndex === scene.orderIndex + 1);
    return next?.chainRole === "continue" &&
      next.chainId &&
      next.chainId === scene.chainId
      ? "download"
      : "submit-only";
  }

  private latestVideoJobMode(sceneId: string): VideoJobMode | null {
    const job = this.repositories.jobs.listByScene(sceneId)
      .filter((entry) => isVideoJobType(entry.jobType))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .at(0);
    return job ? videoJobMode(job.jobType) : null;
  }

  private ensureExtractFrameJob(scene: SceneRecord): JobRecord | null {
    if (scene.chainRole !== "continue" || !scene.chainId) {
      return null;
    }
    const previous = this.repositories.scenes.listByProject(scene.projectId)
      .find((candidate) => candidate.orderIndex === scene.orderIndex - 1);
    if (!previous || previous.chainId !== scene.chainId) {
      throw new Error(`Scene ${publicSceneId(scene.projectId, scene.id)} không có clip trước cùng chain`);
    }
    const existing = this.repositories.jobs.findActive(scene.id, EXTRACT_FRAME_JOB);
    if (existing) return existing;
    const completed = this.repositories.jobs.listByScene(scene.id)
      .filter((job) => job.jobType === EXTRACT_FRAME_JOB && job.status === "succeeded")
      .at(-1) || null;
    if (scene.startFrameAssetPath) return completed;
    const previousVideoJob = this.repositories.jobs.listByScene(previous.id)
      .filter((job) => isVideoJobType(job.jobType) && (
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "succeeded"
      ))
      .at(-1) || null;
    if (!previous.videoAssetPath && !previousVideoJob) {
      throw new Error(`Clip trước của ${publicSceneId(scene.projectId, scene.id)} chưa được xếp hàng`);
    }
    const timestamp = now();
    return this.repositories.jobs.create({
      id: `extract-frame-${randomUUID()}`,
      projectId: scene.projectId,
      sceneId: scene.id,
      jobType: EXTRACT_FRAME_JOB,
      status: "queued",
      dependsOn: previousVideoJob?.id || null,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      lastHeartbeatAt: null,
      lastError: null,
      payloadHash: createHash("sha256").update(JSON.stringify({
        sourceScene: previous.id,
        sourceVideo: previous.videoAssetPath,
        targetScene: scene.id,
      })).digest("hex"),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private async isDirectVideoProject(projectId: string): Promise<boolean> {
    const session = await this.sessionStore.load(projectId);
    return session ? isDirectVideoWorkflowSource(session.workflowSource) : false;
  }

  private removePendingJobsForDirectVideo(projectId: string, fromSceneIndex = 0): void {
    const scenes = this.repositories.scenes.listByProject(projectId);
    const sceneOrder = new Map(scenes.map((scene) => [scene.id, scene.orderIndex]));
    const removableTypes = new Set([IMAGE_JOB, VIDEO_JOB, VIDEO_SUBMIT_JOB, EXTRACT_FRAME_JOB]);
    const removed = this.repositories.jobs.listByProject(projectId)
      .filter((job) =>
        job.sceneId &&
        (sceneOrder.get(job.sceneId) ?? -1) >= fromSceneIndex &&
        removableTypes.has(job.jobType) &&
        (job.status === "queued" || job.status === "failed")
      );
    if (removed.length === 0) return;
    for (const job of removed) {
      this.cancelRetry(job.id);
      this.forcedErrors.delete(job.id);
    }
    const removedIds = removed.map((job) => job.id);
    const affectedSceneIds = [...new Set(removed.flatMap((job) => job.sceneId ? [job.sceneId] : []))];
    this.database.transaction(() => {
      const placeholders = removedIds.map(() => "?").join(", ");
      this.database.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...removedIds);
      for (const sceneId of affectedSceneIds) {
        const hasDirectVideoJob = this.repositories.jobs.listByScene(sceneId)
          .some((job) =>
            (job.jobType === DIRECT_VIDEO_JOB || job.jobType === DIRECT_VIDEO_SUBMIT_JOB) &&
            (job.status === "queued" || job.status === "running")
          );
        if (!hasDirectVideoJob) this.repositories.scenes.resetPendingQueueState(sceneId);
      }
    });
  }

  private async repairContinuationDependencies(
    projectId: string,
    fromSceneIndex = 0,
  ): Promise<void> {
    const scenes = this.repositories.scenes.listByProject(projectId);
    for (const scene of scenes) {
      if (scene.orderIndex < fromSceneIndex || scene.chainRole !== "continue" || !scene.chainId) continue;
      const previous = scenes.find((candidate) => candidate.orderIndex === scene.orderIndex - 1);
      if (!previous?.videoAssetPath) continue;

      const frameExists = Boolean(scene.startFrameAssetPath) && await access(scene.startFrameAssetPath!)
        .then(() => true)
        .catch(() => false);
      if (!frameExists) {
        const refreshed = scene.startFrameAssetPath
          ? this.repositories.scenes.clearContinuationFrame(scene.id)
          : this.repositories.scenes.get(scene.id)!;
        this.ensureExtractFrameJob(refreshed);
        continue;
      }

      const refreshed = this.repositories.scenes.get(scene.id)!;
      if (refreshed.status === "prompt_ready" || refreshed.status === "image_done") {
        this.repositories.scenes.useContinuationFrameAsOpeningImage(
          refreshed.id,
          refreshed.startFrameAssetPath!,
        );
      }
      const ready = this.repositories.scenes.get(scene.id)!;
      if (ready.status === "image_approved" || ready.status === "video_failed") {
        this.enqueueScene(ready, "video");
      }
    }
  }

  private schedulePump(delay: number): void {
    if (this.shutdownRequested) return;
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (this.shutdownRequested) return;
    const runningProjectIds = this.runningProjectIds();
    if (runningProjectIds.length === 0) return;

    const plannedByRole = new Map<WorkerRole, number>();
    const blockedForDisconnectedWorker = new Set<string>();
    const blockedForBusyWorker = new Set<string>();
    const touchedProjectIds = new Set(runningProjectIds);
    let launched = 0;

    const reserveJobSlot = (job: JobRecord): boolean => {
      const role = this.workerRoleForJob(job);
      if (!role) return true;
      const available = this.availableSlotsForRole(role);
      if (available <= 0) {
        if (this.worker.getStatuses()[role]?.connected) blockedForBusyWorker.add(job.projectId);
        else blockedForDisconnectedWorker.add(job.projectId);
        return false;
      }
      const planned = plannedByRole.get(role) || 0;
      if (planned >= available) {
        blockedForBusyWorker.add(job.projectId);
        return false;
      }
      plannedByRole.set(role, planned + 1);
      return true;
    };

    for (const projectId of runningProjectIds) {
      const runtime = this.runtime(projectId);
      if (!runtime.singleRunJobId || this.hasActiveJobs(projectId)) continue;
      let job = this.repositories.jobs.get(runtime.singleRunJobId);
      if (job?.projectId !== projectId) job = null;
      if (job) {
        const dependency = job.dependsOn ? this.repositories.jobs.get(job.dependsOn) : null;
        if (job.status !== "queued" || (dependency && dependency.status !== "succeeded")) {
          if (job.status === "failed" && this.retryTimers.has(job.id)) {
            this.emitChanged(projectId);
            continue;
          }
          const next = this.nextSingleRunJob(projectId);
          if (!next) {
            this.finishSingleRun(projectId);
            continue;
          }
          runtime.singleRunJobId = next.id;
          job = next;
        }
      }
      if (!job) {
        this.finishSingleRun(projectId);
        continue;
      }
      if (!reserveJobSlot(job)) continue;
      launched += 1;
      void this.execute(job).finally(() => {
        if (this.shutdownRequested) return;
        const nextRuntime = this.runtime(projectId);
        const selected = nextRuntime.singleRunJobId
          ? this.repositories.jobs.get(nextRuntime.singleRunJobId)
          : null;
        if (
          selected?.projectId === projectId &&
          (selected.status === "succeeded" || (selected.status === "failed" && !this.retryTimers.has(selected.id)))
        ) {
          const next = this.nextSingleRunJob(projectId);
          if (!next) {
            this.finishSingleRun(projectId);
            return;
          }
          nextRuntime.singleRunJobId = next.id;
        }
        if (nextRuntime.state === "running") this.schedulePump(0);
      });
    }

    for (const job of this.runnableJobs()) {
      if (this.activeJobIds.has(job.id)) continue;
      if (!reserveJobSlot(job)) continue;
      launched += 1;
      void this.execute(job).finally(() => {
        if (!this.shutdownRequested && this.runtime(job.projectId).state === "running") this.schedulePump(0);
      });
    }

    for (const projectId of runningProjectIds) {
      const runtime = this.runtime(projectId);
      if (
        this.hasActiveJobs(projectId) ||
        blockedForDisconnectedWorker.has(projectId) ||
        blockedForBusyWorker.has(projectId) ||
        runtime.resumeRepairPending ||
        this.hasRetryTimers(projectId)
      ) {
        continue;
      }
      runtime.state = "idle";
      this.persistState(projectId);
    }
    this.emitChangedForProjects(touchedProjectIds);
    if (launched === 0 && (blockedForDisconnectedWorker.size > 0 || blockedForBusyWorker.size > 0)) {
      this.schedulePump(blockedForDisconnectedWorker.size > 0 ? this.disconnectedPollMs : 250);
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    if (job.jobType === EXTRACT_FRAME_JOB) {
      await this.executeExtractLastFrame(job);
      return;
    }
    const mediaType = jobMediaType(job.jobType);
    if (!job.sceneId || !mediaType) {
      const error = serializeError({
        category: "response_schema_invalid",
        message: `Queue không có executor cho job ${job.jobType}`,
        retryable: false,
      });
      this.repositories.jobs.updateStatus(job.id, "failed", { error });
      this.emitChanged(job.projectId);
      return;
    }
    const scene = this.repositories.scenes.get(job.sceneId);
    if (!scene) return;
    this.markActiveJob(job);
    const attempt = job.attempts + 1;
    this.repositories.jobs.updateStatus(job.id, "running", {
      attempts: attempt,
      heartbeatAt: now(),
      error: null,
    });
    this.repositories.scenes.updateState({
      sceneId: scene.id,
      to: mediaType === "image" ? "image_generating" : "video_generating",
      error: null,
    });
    this.emitChanged(job.projectId);

    try {
      const queuedVideoMode = videoJobMode(job.jobType);
      if (mediaType === "video") {
        const next = this.repositories.scenes.listByProject(scene.projectId)
          .find((candidate) => candidate.orderIndex === scene.orderIndex + 1);
        if (
          queuedVideoMode !== "direct" &&
          next?.chainRole === "continue" &&
          next.chainId &&
          next.chainId === scene.chainId
        ) {
          await this.invalidateContinuationChain(next);
          this.emitChanged(job.projectId);
        }
      }
      const delivery = mediaType === "video" ? videoJobDelivery(job.jobType) : "download";
      const input = await this.buildWorkerInput(scene, mediaType, queuedVideoMode, delivery);
      const workerResult = await this.worker.runSceneJob(input, () => {
        const current = this.repositories.jobs.get(job.id);
        if (current?.status === "running") {
          this.repositories.jobs.updateStatus(job.id, "running", { heartbeatAt: now() });
        }
      });
      const submittedOnly = mediaType === "video" && workerResult.status === "submitted";
      const result = submittedOnly
        ? workerResult
        : this.generatedMediaRoot
        ? await relocateSceneJobResult(workerResult, this.generatedMediaRoot, input.outputFolder || "default-session")
        : workerResult;
      this.database.transaction(() => {
        this.repositories.jobs.updateStatus(job.id, "succeeded", {
          heartbeatAt: now(),
          error: null,
        });
        this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: mediaType === "image" ? "image_done" : submittedOnly ? "video_submitted" : "video_done",
          imageAssetPath: mediaType === "image" ? result.resultPath : undefined,
          flowImageAssetId: mediaType === "image" ? result.flowAssetKey : undefined,
          videoAssetPath: mediaType === "video" ? result.resultPath || null : undefined,
          error: null,
        });
      });
      const project = this.repositories.projects.get(job.projectId);
      if (mediaType === "image" && project?.autoApproveImages) {
        const approved = this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: "image_approved",
          approvedImage: true,
          error: null,
        });
        const videoJob = this.enqueueScene(approved, "video", job.id);
        const runtime = this.runtime(job.projectId);
        if (runtime.singleRunJobId === job.id) runtime.singleRunJobId = videoJob.id;
      } else if (mediaType === "video" && !submittedOnly && project?.autoApproveVideos) {
        this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: "video_approved",
          approvedVideo: true,
          error: null,
        });
      }
      if (mediaType === "video" && !submittedOnly && queuedVideoMode !== "direct") {
        const next = this.repositories.scenes.listByProject(scene.projectId)
          .find((candidate) => candidate.orderIndex === scene.orderIndex + 1);
        if (next?.chainRole === "continue" && next.chainId && next.chainId === scene.chainId) {
          this.ensureExtractFrameJob(next);
        }
      }
    } catch (caught) {
      const forced = this.forcedErrors.get(job.id);
      this.forcedErrors.delete(job.id);
      if (this.stoppingJobIds.has(job.id)) {
        this.stoppingJobIds.delete(job.id);
        this.repositories.jobs.updateStatus(job.id, "queued", {
          attempts: Math.max(0, attempt - 1),
          heartbeatAt: null,
          error: null,
        });
        this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: mediaType === "image" ? "image_queued" : "video_queued",
          error: null,
          allowRecovery: true,
        });
      } else {
        let classified = forced || classifyQueueError(caught);
        if (
          classified.category === "flow_policy_violation" &&
          attempt < job.maxAttempts &&
          await this.autoRewriteRejectedPrompt(scene, mediaType, classified.message)
        ) {
          classified = {
            category: "flow_policy_violation",
            message: "Prompt đã được tự động viết lại an toàn; đang chờ thử lại Google Flow.",
            retryable: true,
          };
        }
        const serialized = serializeError(classified);
        const failed = this.repositories.jobs.updateStatus(job.id, "failed", {
          heartbeatAt: now(),
          error: serialized,
        });
        this.repositories.scenes.updateState({
          sceneId: scene.id,
          to: mediaType === "image" ? "image_failed" : "video_failed",
          error: serialized,
        });
        if (classified.retryable && failed.attempts < failed.maxAttempts) {
          this.scheduleRetry(failed, job.projectId, false);
        }
      }
    } finally {
      this.clearActiveJob(job.id);
      this.emitChanged(job.projectId);
    }
  }

  private async autoRewriteRejectedPrompt(
    scene: SceneRecord,
    mediaType: SceneMediaType,
    policyError: string,
  ): Promise<boolean> {
    if (!this.worker.rewritePolicyPrompt) return false;
    try {
      const session = await this.sessionStore.load(scene.projectId);
      if (!session) return false;
      const publicId = publicSceneId(scene.projectId, scene.id);
      const timelineScene = session.scenes.find((entry) => entry.id === publicId);
      const policyFlag = timelineScene?.policyFlag || inferPolicyFlag(policyError);
      const rewritten = await this.worker.rewritePolicyPrompt({
        textProvider: await this.getTextProvider(),
        sceneId: publicId,
        mediaType,
        prompt: mediaType === "image" ? scene.imagePrompt : scene.videoPrompt,
        policyError,
        policyFlag,
        timeStart: scene.timeStart,
        timeEnd: scene.timeEnd,
        pairedPrompt: mediaType === "image" ? scene.videoPrompt : scene.imagePrompt,
        visualBible: session.visualBible,
      });
      const imagePrompt = mediaType === "image" ? rewritten.prompt : scene.imagePrompt;
      const videoPrompt = mediaType === "video" ? rewritten.prompt : scene.videoPrompt;
      const removeIdentityReferences = policyFlag === "real_person" || policyFlag === "copyrighted_character";
      const nextTokens = removeIdentityReferences ? [] : scene.usedCharacterTokens;
      this.repositories.scenes.updatePrompts(scene.id, imagePrompt, videoPrompt, nextTokens);
      await this.sessionStore.save({
        visualBible: session.visualBible,
        styleReference: session.styleReference,
        scenes: session.scenes.map((entry) => entry.id === publicId
          ? {
              ...entry,
              imagePrompt,
              videoPrompt,
              usedCharacterTokens: nextTokens,
              assignedCharacterTokens: nextTokens,
              characterPolicy: nextTokens.length > 0 ? "selected" as const : "none" as const,
              policyFlag: null,
              policyResolution: policyFlag
                ? {
                    originalFlag: policyFlag,
                    status: "auto_rewritten" as const,
                    rewrittenMedia: [mediaType],
                    resolvedAt: now(),
                  }
                : entry.policyResolution,
            }
          : entry),
      }, scene.projectId);
      return true;
    } catch {
      return false;
    }
  }

  private async executeExtractLastFrame(job: JobRecord): Promise<void> {
    if (!job.sceneId) return;
    const target = this.repositories.scenes.get(job.sceneId);
    if (!target) return;
    const previous = this.repositories.scenes.listByProject(job.projectId)
      .find((scene) => scene.orderIndex === target.orderIndex - 1);
    this.markActiveJob(job);
    const attempt = job.attempts + 1;
    this.repositories.jobs.updateStatus(job.id, "running", {
      attempts: attempt,
      heartbeatAt: now(),
      error: null,
    });
    try {
      if (!previous?.videoAssetPath) {
        throw new Error("Clip trước chưa có để trích khung hình cuối");
      }
      const outputPath = join(
        dirname(previous.videoAssetPath),
        ".kc-frames",
        `${basename(previous.videoAssetPath, extname(previous.videoAssetPath))}-last-frame.png`,
      );
      await mkdir(dirname(outputPath), { recursive: true });
      await this.extractLastFrame(previous.videoAssetPath, outputPath);
      const frameStat = await stat(outputPath);
      this.database.transaction(() => {
        this.repositories.scenes.useContinuationFrameAsOpeningImage(target.id, outputPath);
        this.repositories.jobs.updateStatus(job.id, "succeeded", {
          heartbeatAt: now(),
          error: null,
        });
      });
      const session = await this.sessionStore.load(job.projectId);
      if (session) {
        const targetPublicId = publicSceneId(job.projectId, target.id);
        await this.sessionStore.save({
          visualBible: session.visualBible,
          styleReference: session.styleReference,
          scenes: session.scenes.map((scene) => scene.id === targetPublicId
            ? {
                ...scene,
                actualContinuityFrame: {
                  path: outputPath,
                  extractedAt: now(),
                  fileSize: frameStat.size,
                },
              }
            : scene),
        }, job.projectId);
      }
      const refreshed = this.repositories.scenes.get(target.id);
      if (refreshed) this.enqueueScene(refreshed, "video", job.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const classified = classifyQueueError(
        new WorkerJobError(message, "EXTRACT_FRAME_FAILED", true),
      );
      const failed = this.repositories.jobs.updateStatus(job.id, "failed", {
        heartbeatAt: now(),
        error: serializeError(classified),
      });
      if (classified.retryable && failed.attempts < failed.maxAttempts) {
        this.scheduleRetry(failed, job.projectId, false);
      }
    } finally {
      this.clearActiveJob(job.id);
      this.emitChanged(job.projectId);
    }
  }

  private async buildWorkerInput(
    scene: SceneRecord,
    mediaType: SceneMediaType,
    videoJobMode: VideoJobMode = "image-first",
    delivery: VideoDeliveryMode = "download",
  ): Promise<BoundSceneJobInput> {
    const bibleRecord = scene.visualBibleId
      ? this.repositories.visualBibles.get(scene.visualBibleId)
      : null;
    let visualBible: VisualBible;
    try {
      visualBible = normalizeVisualBible(JSON.parse(bibleRecord?.payloadJson || "{}"));
    } catch {
      visualBible = normalizeVisualBible({});
    }
    const videoMode = videoJobMode === "direct" ? "text-to-video" : "first-frame";
    const characterRefs = mediaType === "image"
      ? await this.characterStore.resolveReferences(scene.usedCharacterTokens)
      : [];
    const refImages = characterRefs;
    const continuationOpeningFrame = mediaType === "video" && videoJobMode !== "direct" && scene.chainRole === "continue"
      ? scene.startFrameAssetPath || ""
      : "";
    const imageProvider = this.getImageProvider(scene.projectId);
    const videoProvider = this.getVideoProvider(scene.projectId);
    const sourceImagePath = mediaType === "video" && videoJobMode !== "direct"
      ? continuationOpeningFrame || scene.imageAssetPath || ""
      : "";
    return {
      sceneId: publicSceneId(scene.projectId, scene.id),
      outputFolder: projectOutputFolder(
        scene.projectId,
        this.repositories.projects.get(scene.projectId)?.name || "Phiên làm việc",
      ),
      mediaType,
      prompt: mediaType === "image" ? scene.imagePrompt : scene.videoPrompt,
      characterTokens: mediaType === "image" ? scene.usedCharacterTokens : [],
      visualBible,
      imageSettings: {
        provider: imageProvider,
        model: imageModelForProvider(imageProvider),
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath,
      sourceFlowAssetKey: mediaType === "video" && videoJobMode !== "direct" && !continuationOpeningFrame
        ? scene.flowImageAssetId || ""
        : "",
      startFramePath: "",
      videoSettings: {
        provider: videoProvider,
        model: videoModelForProvider(videoProvider),
        mode: videoMode,
        delivery: mediaType === "video" ? delivery : "download",
        aspectRatio: "16:9",
        durationSeconds: scene.durationSeconds,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages,
      sourceImage: mediaType === "video" && videoProvider !== "google-flow" && videoJobMode !== "direct"
        ? await resolveSceneSourceImage(sourceImagePath)
        : null,
    };
  }

  private scheduleRetry(job: JobRecord, projectId: string, recovering: boolean): void {
    if (this.shutdownRequested) return;
    if (this.retryTimers.has(job.id)) return;
    const index = Math.min(Math.max(job.attempts - 1, 0), this.retryBackoffMs.length - 1);
    const fullDelay = this.retryBackoffMs[index] || 0;
    const elapsed = recovering ? Math.max(0, Date.now() - Date.parse(job.updatedAt)) : 0;
    const delay = Math.max(0, fullDelay - elapsed);
    const timer = setTimeout(() => {
      this.retryTimers.delete(job.id);
      if (this.shutdownRequested) return;
      const current = this.repositories.jobs.get(job.id);
      if (!current || current.status !== "failed") return;
      const error = parseError(current.lastError);
      if (!error?.retryable || current.attempts >= current.maxAttempts) return;
      this.repositories.jobs.updateStatus(current.id, "queued", { heartbeatAt: null });
      if (current.sceneId) {
        const mediaType = jobMediaType(current.jobType);
        if (mediaType) {
          this.repositories.scenes.updateState({
            sceneId: current.sceneId,
            to: mediaType === "image" ? "image_queued" : "video_queued",
            error: null,
          });
        }
      }
      const runtime = this.runtime(projectId);
      if (runtime.state !== "paused" && runtime.state !== "stopped") runtime.state = "running";
      this.persistState(projectId);
      this.emitChanged(projectId);
      this.schedulePump(0);
    }, delay);
    this.retryTimers.set(job.id, timer);
  }

  private cancelRetry(jobId: string): void {
    const timer = this.retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(jobId);
  }

  private checkHeartbeat(): void {
    for (const job of this.activeJobRecords()) {
      if (job.status !== "running") continue;
      const heartbeat = Date.parse(job.lastHeartbeatAt || job.updatedAt);
      if (Date.now() - heartbeat <= this.heartbeatTimeoutMs) continue;
      this.forcedErrors.set(job.id, {
        category: "timeout_no_response",
        message: `Job không có heartbeat trong ${Math.ceil(this.heartbeatTimeoutMs / 1_000)} giây`,
        retryable: true,
      });
      const role = this.workerRoleForJob(job);
      if (role) this.worker.stopActiveJob(role, job.id);
    }
  }

  private resolveSceneId(projectId: string, sceneId: string): string {
    return sceneId.startsWith(`${projectId}:`) ? sceneId : `${projectId}:${sceneId}`;
  }

  private requireScene(projectId: string, sceneId: string): SceneRecord {
    const scene = this.repositories.scenes.get(this.resolveSceneId(projectId, sceneId));
    if (!scene || scene.projectId !== projectId) throw new Error(`Không tìm thấy scene ${sceneId}`);
    return scene;
  }

  private runtime(projectId = this.activeProjectId): ProjectQueueRuntime {
    let runtime = this.projectRuntimes.get(projectId);
    if (!runtime) {
      runtime = createProjectRuntime();
      this.projectRuntimes.set(projectId, runtime);
    }
    return runtime;
  }

  private runningProjectIds(): string[] {
    const projectIds = new Set([
      ...this.repositories.projects.list().map((project) => project.id),
      ...this.projectRuntimes.keys(),
    ]);
    return [...projectIds].filter((projectId) => this.runtime(projectId).state === "running");
  }

  private hasQueuedJobs(projectId: string): boolean {
    return this.repositories.jobs.listByProject(projectId).some((job) => job.status === "queued");
  }

  private hasRetryTimers(projectId: string): boolean {
    for (const jobId of this.retryTimers.keys()) {
      const job = this.repositories.jobs.get(jobId);
      if (job?.projectId === projectId) return true;
    }
    return false;
  }

  private emitChanged(projectId = this.activeProjectId): void {
    this.onChanged(this.getSnapshot(projectId));
  }

  private emitChangedForProjects(projectIds: Iterable<string>): void {
    for (const projectId of projectIds) this.emitChanged(projectId);
  }

  private finishSingleRun(projectId: string): void {
    const runtime = this.runtime(projectId);
    runtime.singleRunJobId = null;
    runtime.singleRunSceneIds.clear();
    const restore = runtime.stateAfterSingleRun;
    runtime.stateAfterSingleRun = null;
    runtime.state = restore || "idle";
    this.persistState(projectId);
    this.emitChanged(projectId);
  }

  private nextSingleRunJob(projectId: string): JobRecord | null {
    const runtime = this.runtime(projectId);
    if (runtime.singleRunSceneIds.size === 0) return null;
    const sceneOrder = new Map(
      this.repositories.scenes.listByProject(projectId)
        .map((scene) => [scene.id, scene.orderIndex]),
    );
    return this.repositories.jobs.listByProject(projectId)
      .filter((job) => {
        if (job.status !== "queued" || !job.sceneId || !runtime.singleRunSceneIds.has(job.sceneId)) {
          return false;
        }
        const dependency = job.dependsOn ? this.repositories.jobs.get(job.dependsOn) : null;
        return !dependency || dependency.status === "succeeded";
      })
      .sort((left, right) =>
        (sceneOrder.get(left.sceneId || "") ?? Number.MAX_SAFE_INTEGER) -
          (sceneOrder.get(right.sceneId || "") ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt)
      )[0] || null;
  }

  private async invalidateContinuationChain(first: SceneRecord): Promise<void> {
    const projectScenes = this.repositories.scenes.listByProject(first.projectId);
    const chain: SceneRecord[] = [];
    for (let orderIndex = first.orderIndex; ; orderIndex += 1) {
      const scene = projectScenes.find((candidate) => candidate.orderIndex === orderIndex);
      if (!scene || scene.chainRole !== "continue" || scene.chainId !== first.chainId) break;
      chain.push(scene);
    }
    if (chain.length === 0) return;

    const chainIds = new Set(chain.map((scene) => scene.id));
    const paths = chain.flatMap((scene) => [
      scene.startFrameAssetPath,
      scene.imageAssetPath,
      scene.videoAssetPath,
    ].filter((path): path is string => Boolean(path?.trim())));
    const deletedPathKeys = await this.removeGeneratedPathsForReplacement(
      first.projectId,
      chainIds,
      paths,
    );

    const session = await this.sessionStore.load(first.projectId);
    if (!session) throw new Error("Không tìm thấy phiên Phase 3 để làm mới chuỗi continue.");
    const publicIds = new Set(chain.map((scene) => publicSceneId(first.projectId, scene.id)));
    await this.sessionStore.save({
      visualBible: session.visualBible,
      styleReference: session.styleReference,
      scenes: session.scenes.map((scene) => publicIds.has(scene.id)
        ? {
            ...scene,
            imageStatus: "pending" as const,
            imageResultPath: "",
            imageFlowAssetKey: "",
            imageApproved: false,
            videoStatus: "pending" as const,
            videoResultPath: "",
            videoApproved: false,
            actualContinuityFrame: undefined,
          }
        : scene),
    }, first.projectId);

    const allJobs = this.repositories.jobs.listByProject(first.projectId);
    const removedJobIds = new Set(
      allJobs.filter((job) => job.sceneId && chainIds.has(job.sceneId)).map((job) => job.id),
    );
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const job of allJobs) {
        if (removedJobIds.has(job.id) || !job.dependsOn || !removedJobIds.has(job.dependsOn)) continue;
        removedJobIds.add(job.id);
        expanded = true;
      }
    }
    for (const jobId of removedJobIds) {
      this.cancelRetry(jobId);
      this.forcedErrors.delete(jobId);
    }
    const affectedJobSceneIds = new Set(
      allJobs.filter((job) => removedJobIds.has(job.id) && job.sceneId).map((job) => job.sceneId!),
    );
    this.database.transaction(() => {
      if (removedJobIds.size > 0) {
        const placeholders = [...removedJobIds].map(() => "?").join(", ");
        this.database.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...removedJobIds);
      }
      for (const scene of chain) {
        this.database.db.prepare(`
          UPDATE scenes SET
            start_frame_asset_path = NULL,
            status = 'prompt_ready',
            image_asset_path = NULL,
            flow_image_asset_id = NULL,
            video_asset_path = NULL,
            approved_image = 0,
            approved_video = 0,
            last_error = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(now(), scene.id);
      }
      for (const affectedSceneId of affectedJobSceneIds) {
        if (!chainIds.has(affectedSceneId)) {
          this.repositories.scenes.resetPendingQueueState(affectedSceneId);
        }
      }
      for (const bible of this.repositories.visualBibles.listByProject(first.projectId)) {
        const retainedAnchors = bible.anchorImagePaths.filter((path) =>
          !deletedPathKeys.has(normalizedPath(path))
        );
        this.repositories.visualBibles.setAnchors(bible.id, retainedAnchors, bible.locked);
      }
    });
  }

  private async removeGeneratedPathsForReplacement(
    projectId: string,
    replacedSceneIds: Set<string>,
    paths: string[],
  ): Promise<Set<string>> {
    const trackedPaths = [...new Set(paths.filter((path) => path.trim()))];
    const sharedPathKeys = new Set<string>();
    const rows = this.database.db.prepare(`
      SELECT id, start_frame_asset_path, image_asset_path, video_asset_path FROM scenes
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.id === "string" && replacedSceneIds.has(row.id)) continue;
      for (const value of [row.start_frame_asset_path, row.image_asset_path, row.video_asset_path]) {
        if (typeof value === "string" && value.trim()) sharedPathKeys.add(normalizedPath(value));
      }
    }
    const replacedPublicIds = new Set([...replacedSceneIds].map((id) => publicSceneId(projectId, id)));
    for (const summary of await this.sessionStore.list()) {
      const session = await this.sessionStore.load(summary.id);
      for (const storedScene of session?.scenes || []) {
        if (summary.id === projectId && replacedPublicIds.has(storedScene.id)) continue;
        for (const value of [storedScene.imageResultPath, storedScene.videoResultPath]) {
          if (value?.trim()) sharedPathKeys.add(normalizedPath(value));
        }
      }
    }
    const deletablePaths = trackedPaths.filter((path) => !sharedPathKeys.has(normalizedPath(path)));
    const roots = new Map<string, string>();
    if (this.generatedMediaRoot) roots.set(normalizedPath(this.generatedMediaRoot), this.generatedMediaRoot);
    for (const path of deletablePaths) {
      const root = generatedMediaRootFromPath(path);
      if (root) roots.set(normalizedPath(root), validateGeneratedMediaRoot(root));
    }
    for (const path of deletablePaths) {
      const insideKnownRoot = [...roots.values()].some((root) => isInsideDirectory(path, root));
      if (insideKnownRoot) continue;
      const exists = await access(path).then(() => true, () => false);
      if (exists) throw new Error(`Không thay thế vì file cũ nằm ngoài thư mục ${APP_BRAND_NAME}: ${path}`);
    }
    const deletedPathKeys = new Set<string>();
    for (const path of deletablePaths) {
      const exists = await access(path).then(() => true, () => false);
      if (!exists) continue;
      await removeGeneratedPathWithRetry(path);
      deletedPathKeys.add(normalizedPath(path));
    }
    return deletedPathKeys;
  }

  private resetProjectRuntime(projectId: string, state: QueueRuntimeState): void {
    const runtime = this.runtime(projectId);
    runtime.state = state;
    runtime.singleRunJobId = null;
    runtime.singleRunSceneIds.clear();
    runtime.stateAfterSingleRun = null;
    runtime.resumeRepairPending = false;
  }

  private cancelRetriesForProject(projectId: string, knownJobIds = new Set<string>()): void {
    for (const jobId of [...this.retryTimers.keys()]) {
      const job = this.repositories.jobs.get(jobId);
      if (job?.projectId === projectId || knownJobIds.has(jobId)) this.cancelRetry(jobId);
    }
  }

  private clearForcedErrorsForProject(projectId: string, knownJobIds = new Set<string>()): void {
    for (const jobId of [...this.forcedErrors.keys()]) {
      const job = this.repositories.jobs.get(jobId);
      if (job?.projectId === projectId || knownJobIds.has(jobId)) this.forcedErrors.delete(jobId);
    }
  }

  private clearActiveJobsForProject(projectId: string, knownJobIds = new Set<string>()): void {
    for (const jobId of [...this.activeJobIds]) {
      const job = this.repositories.jobs.get(jobId);
      if (job?.projectId === projectId || knownJobIds.has(jobId)) this.clearActiveJob(jobId);
    }
  }

  private clearStoppingJobsForProject(projectId: string, knownJobIds = new Set<string>()): void {
    for (const jobId of [...this.stoppingJobIds]) {
      const job = this.repositories.jobs.get(jobId);
      if (job?.projectId === projectId || knownJobIds.has(jobId)) this.stoppingJobIds.delete(jobId);
    }
  }

  private stateMetadataKey(projectId: string): string {
    return `${QUEUE_STATE_METADATA_PREFIX}${projectId}`;
  }

  private persistedState(projectId: string): QueueRuntimeState | null {
    const scoped = this.repositories.metadata.get(this.stateMetadataKey(projectId));
    if (scoped === "paused" || scoped === "stopped") return scoped;
    if (projectId !== DEFAULT_PROJECT_ID) return null;
    const legacy = this.repositories.metadata.get(LEGACY_QUEUE_STATE_METADATA_KEY);
    return legacy === "paused" || legacy === "stopped" ? legacy : null;
  }

  private persistState(projectId: string): void {
    this.repositories.metadata.set(this.stateMetadataKey(projectId), this.runtime(projectId).state);
  }
}
