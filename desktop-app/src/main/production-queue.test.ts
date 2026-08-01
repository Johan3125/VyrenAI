import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CharacterStore } from "./character-store";
import { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";
import { classifyQueueError, ProductionQueue } from "./production-queue";
import { syncTimelineSessionToProject } from "./production-session-sync";
import { TimelineSessionStore } from "./timeline-session-store";
import { WorkerJobError } from "./worker-server";
import { STORAGE_FOLDER_NAME } from "../shared/brand";
import { DEFAULT_PROJECT_ID } from "../shared/production-queue";
import { projectOutputFolder, type BoundSceneJobInput, type SceneJobProgress } from "../shared/scene-job";
import type { PolicyPromptRewriteInput, TimelineSessionInput } from "../shared/timeline";
import type { WorkerConnectionStatus, WorkerRole } from "../shared/worker-status";

function timeline(sceneCount = 2): TimelineSessionInput {
  return {
    visualBible: {
      style: "Stickman, flat 2D illustration",
      palette: "Black, white and muted blue",
      lighting: "Soft daylight",
      continuityNotes: "Keep every character and location consistent",
      aspectRatio: "16:9",
    },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      id: `scene-${String(index + 1).padStart(3, "0")}`,
      order: index + 1,
      timeStart: `00:00:${String(index * 8).padStart(2, "0")},000`,
      timeEnd: `00:00:${String((index + 1) * 8).padStart(2, "0")},000`,
      imagePrompt: `Image prompt ${index + 1}`,
      imageStatus: "pending" as const,
      imageResultPath: "",
      imageFlowAssetKey: "",
      imageApproved: false,
      videoPrompt: `Video prompt ${index + 1}`,
      videoStatus: "pending" as const,
      videoResultPath: "",
      videoApproved: false,
      usedCharacterTokens: [],
      characterPolicy: "none" as const,
      assignedCharacterTokens: [],
      chainId: null,
      chainRole: "single" as const,
      durationSeconds: 8 as const,
    })),
  };
}

function statuses(connected: boolean) {
  const status = (role: "chat-worker" | "flow-worker"): WorkerConnectionStatus => ({
    role,
    connected: role === "flow-worker" ? connected : false,
    profileTag: connected ? "queue-test" : null,
    connectedAt: connected ? new Date().toISOString() : null,
  });
  return { "chat-worker": status("chat-worker"), "flow-worker": status("flow-worker") };
}

test("classifies Flow safety blocks as non-retryable policy violations", () => {
  assert.deepEqual(classifyQueueError(new Error("Google Flow blocked this prompt because of its safety policy")), {
    category: "flow_policy_violation",
    message: "Google Flow blocked this prompt because of its safety policy",
    retryable: false,
  });
});

test("classifies a Flow generation failure separately from schema-invalid", () => {
  assert.deepEqual(
    classifyQueueError(new WorkerJobError("warningKhông thành công", "FLOW_GENERATION_FAILED", false)),
    {
      category: "flow_generation_failed",
      message: "warningKhông thành công",
      retryable: false,
    },
  );
});

test("keeps Gemini/Grok quota failures retryable even when the message says generation failed", () => {
  assert.deepEqual(
    classifyQueueError(new WorkerJobError(
      "Gemini không tạo được video: đã đạt giới hạn sử dụng",
      "QUOTA_OR_RATE_LIMIT",
      true,
    )),
    {
      category: "flow_quota_or_rate_limit",
      message: "Gemini không tạo được video: đã đạt giới hạn sử dụng",
      retryable: true,
    },
  );
});

class FakeQueueWorker {
  readonly calls: string[] = [];
  readonly inputs: BoundSceneJobInput[] = [];
  failFirstSceneOnce = false;
  failFirstScenePolicyOnce = false;
  readonly policyRewriteCalls: PolicyPromptRewriteInput[] = [];
  connected = true;
  resultDirectory = "C:\\FlowX";
  persistResults = false;

  getStatuses() {
    return statuses(this.connected);
  }

  stopActiveJob(): boolean {
    return false;
  }

  async runSceneJob(
    input: BoundSceneJobInput,
    onProgress: (progress: SceneJobProgress) => void = () => {},
  ) {
    this.calls.push(`${input.sceneId}:${input.mediaType}`);
    this.inputs.push(input);
    onProgress({
      jobId: `fake-${this.calls.length}`,
      sceneId: input.sceneId,
      mediaType: input.mediaType,
      status: "generating",
    });
    if (
      this.failFirstSceneOnce &&
      input.sceneId === "scene-001" &&
      this.calls.filter((call) => call === "scene-001:image").length === 1
    ) {
      throw new WorkerJobError("Flow DOM element not found", "FLOW_UI_CHANGED", true);
    }
    if (
      this.failFirstScenePolicyOnce &&
      input.sceneId === "scene-001" &&
      this.calls.filter((call) => call === "scene-001:image").length === 1
    ) {
      throw new WorkerJobError(
        "Google Flow blocked this real person prompt under its safety policy",
        "POLICY_VIOLATION",
        false,
      );
    }
    if (input.mediaType === "video" && input.videoSettings.delivery === "submit-only") {
      return {
        sceneId: input.sceneId,
        mediaType: input.mediaType,
        resultPath: "",
        flowAssetKey: "",
        status: "submitted" as const,
        submittedAt: new Date().toISOString(),
      };
    }
    const resultPath = join(this.resultDirectory, `${input.sceneId}.${input.mediaType === "image" ? "png" : "mp4"}`);
    if (this.persistResults) await writeFile(resultPath, `fake-${input.mediaType}`);
    return {
      sceneId: input.sceneId,
      mediaType: input.mediaType,
      resultPath,
      flowAssetKey: input.mediaType === "image" ? `asset:${input.sceneId}` : "",
    };
  }

  async rewritePolicyPrompt(input: PolicyPromptRewriteInput) {
    this.policyRewriteCalls.push(input);
    return { prompt: `Safe rewritten ${input.mediaType} prompt` };
  }
}

class ChatImageQueueWorker extends FakeQueueWorker {
  override getStatuses() {
    const connectedAt = new Date().toISOString();
    return {
      "chat-worker": {
        role: "chat-worker" as const,
        connected: true,
        profileTag: "chat-image-test",
        connectedAt,
      },
      "flow-worker": {
        role: "flow-worker" as const,
        connected: false,
        profileTag: null,
        connectedAt: null,
      },
    };
  }
}

class ProviderMediaQueueWorker extends FakeQueueWorker {
  override getStatuses() {
    const connectedAt = new Date().toISOString();
    return {
      "chat-worker": {
        role: "chat-worker" as const,
        connected: false,
        profileTag: null,
        connectedAt: null,
      },
      "flow-worker": {
        role: "flow-worker" as const,
        connected: false,
        profileTag: null,
        connectedAt: null,
      },
      "gemini-worker": {
        role: "gemini-worker" as const,
        connected: true,
        profileTag: "gemini-media-test",
        connectedAt,
      },
      "grok-worker": {
        role: "grok-worker" as const,
        connected: true,
        profileTag: "grok-media-test",
        connectedAt,
      },
      "capcut-worker": {
        role: "capcut-worker" as const,
        connected: true,
        profileTag: "capcut-media-test",
        connectedAt,
      },
    };
  }
}

class BlockingMultiRoleQueueWorker extends FakeQueueWorker {
  private readonly activeRoles = new Set<WorkerRole>();
  private readonly pending = new Map<string, () => void>();

  override getStatuses() {
    const connectedAt = new Date().toISOString();
    const status = (role: "chat-worker" | "flow-worker") => ({
      role,
      connected: true,
      profileTag: `blocking-${role}`,
      connectedAt,
      connectedCount: 1,
      busyCount: this.activeRoles.has(role) ? 1 : 0,
      idleCount: this.activeRoles.has(role) ? 0 : 1,
    });
    return {
      "chat-worker": status("chat-worker"),
      "flow-worker": status("flow-worker"),
    };
  }

  getAvailableSlots(role: WorkerRole): number {
    if (role !== "chat-worker" && role !== "flow-worker") return 0;
    return this.activeRoles.has(role) ? 0 : 1;
  }

  override async runSceneJob(
    input: BoundSceneJobInput,
    onProgress: (progress: SceneJobProgress) => void = () => {},
  ) {
    const role: WorkerRole = input.mediaType === "image" && input.imageSettings.provider === "chatgpt-image"
      ? "chat-worker"
      : "flow-worker";
    this.activeRoles.add(role);
    const key = `${input.sceneId}:${input.mediaType}`;
    this.calls.push(key);
    this.inputs.push(input);
    onProgress({
      jobId: `blocking-${this.calls.length}`,
      sceneId: input.sceneId,
      mediaType: input.mediaType,
      status: "generating",
    });
    try {
      await new Promise<void>((resolve) => {
        this.pending.set(key, resolve);
      });
      if (input.mediaType === "video" && input.videoSettings.delivery === "submit-only") {
        return {
          sceneId: input.sceneId,
          mediaType: input.mediaType,
          resultPath: "",
          flowAssetKey: "",
          status: "submitted" as const,
          submittedAt: new Date().toISOString(),
        };
      }
      return {
        sceneId: input.sceneId,
        mediaType: input.mediaType,
        resultPath: join(this.resultDirectory, `${input.sceneId}.${input.mediaType === "image" ? "png" : "mp4"}`),
        flowAssetKey: input.mediaType === "image" ? `asset:${input.sceneId}` : "",
      };
    } finally {
      this.pending.delete(key);
      this.activeRoles.delete(role);
    }
  }

  release(key: string): void {
    this.pending.get(key)?.();
  }
}

test("automatically rewrites and retries a Flow policy rejection", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.failFirstScenePolicyOnce = true;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      retryBackoffMs: [5],
      maxAttempts: 3,
      getTextProvider: () => "gemini",
    },
  );
  try {
    await queue.start();
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.equal(worker.policyRewriteCalls.length, 1);
    assert.equal(worker.policyRewriteCalls[0].textProvider, "gemini");
    assert.equal(worker.policyRewriteCalls[0].policyFlag, "real_person");
    assert.equal(worker.calls.filter((call) => call === "scene-001:image").length, 2);
    assert.equal(queue.getSnapshot().errors.length, 0);
    const session = await context.sessionStore.load();
    assert.equal(session?.scenes[0].imagePrompt, "Safe rewritten image prompt");
    assert.equal(session?.scenes[0].policyResolution?.status, "auto_rewritten");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("runs image jobs through the ChatGPT image provider without a Flow worker", async () => {
  const context = await fixture();
  const worker = new ChatImageQueueWorker();
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5], maxAttempts: 3 },
  );
  try {
    await queue.start();
    queue.setImageProvider("chatgpt-image", DEFAULT_PROJECT_ID);
    await queue.generateAllImages(DEFAULT_PROJECT_ID, { imageProvider: "chatgpt-image" });
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, ["scene-001:image", "scene-002:image"]);
    assert.equal(worker.inputs[0].imageSettings.provider, "chatgpt-image");
    assert.equal(worker.inputs[0].imageSettings.model, "chatgpt-web");
    assert.equal(queue.getSnapshot().imageProvider, "chatgpt-image");
    assert.equal(queue.getSnapshot().errors.length, 0);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("uses Gemini/Grok media providers as real queue defaults", async () => {
  const context = await fixture();
  const worker = new ProviderMediaQueueWorker();
  worker.resultDirectory = context.directory;
  worker.persistResults = true;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      retryBackoffMs: [5],
      maxAttempts: 3,
      defaultImageProvider: "gemini-image",
      defaultVideoProvider: "grok-video",
    },
  );
  try {
    await queue.start();
    assert.equal(queue.getSnapshot().imageProvider, "gemini-image");
    assert.equal(queue.getSnapshot().videoProvider, "grok-video");

    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, [
      "scene-001:image",
      "scene-002:image",
      "scene-001:video",
      "scene-002:video",
    ]);
    assert.equal(worker.inputs[0].imageSettings.provider, "gemini-image");
    assert.equal(worker.inputs[0].imageSettings.model, "gemini-web");
    const grokVideoInput = worker.inputs.find((input) => input.mediaType === "video");
    assert.equal(grokVideoInput?.videoSettings.provider, "grok-video");
    assert.equal(grokVideoInput?.videoSettings.model, "grok-imagine-video-web");
    assert.equal(grokVideoInput?.sourceImage?.token, "@SOURCE_FRAME");
    assert.ok(grokVideoInput?.sourceImage?.imageBase64);

    queue.setImageProvider("grok-image", DEFAULT_PROJECT_ID);
    queue.setVideoProvider("gemini-video", DEFAULT_PROJECT_ID);
    assert.equal(queue.getSnapshot().imageProvider, "grok-image");
    assert.equal(queue.getSnapshot().videoProvider, "gemini-video");
    queue.setVideoProvider("capcut-video", DEFAULT_PROJECT_ID);
    assert.equal(queue.getSnapshot().videoProvider, "capcut-video");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("queues direct Google Flow videos from prompts without scene images", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5], maxAttempts: 3 },
  );
  try {
    await queue.start();
    queue.setVideoProvider("google-flow", DEFAULT_PROJECT_ID);
    await queue.generateAllVideos(DEFAULT_PROJECT_ID, {
      onlyApprovedImages: false,
      videoMode: "text-to-video",
      videoProvider: "google-flow",
    });
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, ["scene-001:video", "scene-002:video"]);
    assert.ok(worker.inputs.every((input) => input.videoSettings.provider === "google-flow"));
    assert.ok(worker.inputs.every((input) => input.videoSettings.model === "veo-3.1-lite"));
    assert.ok(worker.inputs.every((input) => input.videoSettings.mode === "text-to-video"));
    assert.ok(worker.inputs.every((input) => input.videoSettings.delivery === "submit-only"));
    assert.ok(worker.inputs.every((input) => input.sourceImagePath === ""));
    assert.ok(worker.inputs.every((input) => input.sourceImage == null));
    const directJobs = context.database.db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE job_type = 'video_submission_direct'",
    ).get() as { count: number };
    assert.equal(directJobs.count, 2);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("removes stale image-first jobs before starting direct prompt videos", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  syncTimelineSessionToProject(context.database, (await context.sessionStore.load())!, []);
  const repositories = new ProjectRepositories(context.database);
  const [first, second] = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  repositories.scenes.transition({
    sceneId: first.id,
    to: "image_queued",
    jobType: "image_generation",
    payloadHash: "stale-image-job",
  });
  repositories.scenes.transition({
    sceneId: second.id,
    to: "video_queued",
    jobType: "video_generation",
    payloadHash: "stale-image-first-video-job",
  });
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5], maxAttempts: 3 },
  );
  try {
    await queue.start();
    await queue.generateAllVideos(DEFAULT_PROJECT_ID, {
      onlyApprovedImages: false,
      videoMode: "text-to-video",
      videoProvider: "google-flow",
    });
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, ["scene-001:video", "scene-002:video"]);
    assert.ok(worker.inputs.every((input) => input.videoSettings.mode === "text-to-video"));
    const jobs = context.database.db.prepare(
      "SELECT job_type AS jobType FROM jobs ORDER BY created_at",
    ).all() as Array<{ jobType: string }>;
    assert.deepEqual(jobs.map((job) => job.jobType), [
      "video_submission_direct",
      "video_submission_direct",
    ]);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("keeps direct text-to-video continuation scenes independent from extracted frames", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.resultDirectory = context.directory;
  worker.persistResults = true;
  const original = await context.sessionStore.load();
  assert.ok(original);
  await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((scene, index) => ({
      ...scene,
      chainId: "direct-chain",
      chainRole: index === 0 ? "start" as const : "continue" as const,
    })),
  });
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      retryBackoffMs: [5],
      maxAttempts: 3,
      extractLastFrame: async (_videoPath, outputPath) => {
        await writeFile(outputPath, "fake-direct-frame");
      },
    },
  );
  try {
    await queue.start();
    await queue.generateAllVideos(DEFAULT_PROJECT_ID, {
      onlyApprovedImages: false,
      videoMode: "text-to-video",
      videoProvider: "google-flow",
    });
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, ["scene-001:video", "scene-002:video"]);
    assert.equal(worker.inputs[0].videoSettings.mode, "text-to-video");
    assert.equal(worker.inputs[0].sourceImagePath, "");
    assert.equal(worker.inputs[1].videoSettings.mode, "text-to-video");
    assert.equal(worker.inputs[1].sourceImagePath, "");
    const jobs = context.database.db.prepare(
      "SELECT job_type AS jobType FROM jobs ORDER BY created_at",
    ).all() as Array<{ jobType: string }>;
    assert.deepEqual(jobs.map((job) => job.jobType), [
      "video_submission_direct",
      "video_submission_direct",
    ]);
    assert.equal(queue.getSnapshot().scenes.every((scene) => scene.status === "video_submitted" && !scene.videoAssetPath), true);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

class StuckQueueWorker extends FakeQueueWorker {
  private rejectActive: ((error: Error) => void) | null = null;

  override runSceneJob(
    input: BoundSceneJobInput,
    _onProgress: (progress: SceneJobProgress) => void = () => {},
  ): Promise<never> {
    this.calls.push(`${input.sceneId}:${input.mediaType}`);
    return new Promise((_resolve, reject) => {
      this.rejectActive = reject;
    });
  }

  override stopActiveJob(): boolean {
    if (!this.rejectActive) return false;
    const reject = this.rejectActive;
    this.rejectActive = null;
    reject(new WorkerJobError("Worker stopped after heartbeat timeout", "STOPPED"));
    return true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for queue state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowx-production-queue-"));
  const database = new ProjectDatabase(join(directory, "flowx.sqlite"));
  const sessionStore = new TimelineSessionStore(join(directory, "timeline"));
  const characterStore = new CharacterStore(join(directory, "characters"));
  await Promise.all([database.initialize(), sessionStore.initialize(), characterStore.initialize()]);
  await sessionStore.save(timeline());
  return { directory, database, sessionStore, characterStore };
}

test("syncs Beat & Chain planning metadata from the saved timeline into SQLite", async () => {
  const context = await fixture();
  try {
    const original = await context.sessionStore.load();
    assert.ok(original);
    const planned = await context.sessionStore.save({
      ...original,
      scenes: original.scenes.map((scene, index) => index === 0
        ? {
            ...scene,
            timeEnd: "00:00:06,000",
            durationSeconds: 6,
            chainId: "walk-cycle",
            chainRole: "start",
          }
        : {
            ...scene,
            timeStart: "00:00:06,000",
            timeEnd: "00:00:10,000",
            durationSeconds: 4,
            chainId: "walk-cycle",
            chainRole: "continue",
          }),
    });
    syncTimelineSessionToProject(context.database, planned, []);
    const stored = new ProjectRepositories(context.database).scenes.listByProject(DEFAULT_PROJECT_ID);
    assert.deepEqual(stored.map((scene) => ({
      durationSeconds: scene.durationSeconds,
      chainId: scene.chainId,
      chainRole: scene.chainRole,
      timeStart: scene.timeStart,
      timeEnd: scene.timeEnd,
    })), [
      { durationSeconds: 6, chainId: "walk-cycle", chainRole: "start", timeStart: "00:00:00,000", timeEnd: "00:00:06,000" },
      { durationSeconds: 4, chainId: "walk-cycle", chainRole: "continue", timeStart: "00:00:06,000", timeEnd: "00:00:10,000" },
    ]);
  } finally {
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("accepts an isolated generated media output root", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const outputRoot = join(context.directory, "outputs");
  await mkdir(outputRoot, { recursive: true });
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { generatedMediaRoot: outputRoot },
  );
  try {
    await queue.start();
    assert.equal(queue.getSnapshot().state, "idle");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("runs separate sessions concurrently when their worker roles are free", async () => {
  const context = await fixture();
  const imageProjectId = "parallel-image-session";
  const videoProjectId = "parallel-video-session";
  await context.sessionStore.save(timeline(1), imageProjectId);
  await context.sessionStore.save(timeline(1), videoProjectId);
  const worker = new BlockingMultiRoleQueueWorker();
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5], maxAttempts: 3 },
  );
  try {
    await queue.start();
    queue.setImageProvider("chatgpt-image", imageProjectId);
    queue.setVideoProvider("google-flow", videoProjectId);
    await queue.generateAllImages(imageProjectId, { imageProvider: "chatgpt-image" });
    await waitFor(() => worker.calls.includes("scene-001:image"));
    await queue.generateAllVideos(videoProjectId, {
      onlyApprovedImages: false,
      videoMode: "text-to-video",
      videoProvider: "google-flow",
    });
    await waitFor(() => worker.calls.includes("scene-001:video"));

    const imageSnapshot = queue.getSnapshot(imageProjectId);
    const videoSnapshot = queue.getSnapshot(videoProjectId);
    assert.equal(imageSnapshot.activeJobs.length, 1);
    assert.equal(videoSnapshot.activeJobs.length, 1);
    assert.equal(imageSnapshot.activeJobs[0].workerRole, "chat-worker");
    assert.equal(videoSnapshot.activeJobs[0].workerRole, "flow-worker");

    worker.release("scene-001:image");
    worker.release("scene-001:video");
    await waitFor(() =>
      queue.getSnapshot(imageProjectId).activeJobs.length === 0 &&
      queue.getSnapshot(videoProjectId).activeJobs.length === 0
    );
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("pausing one session does not block another session queue", async () => {
  const context = await fixture();
  const pausedProjectId = "paused-session";
  const runningProjectId = "running-session";
  await context.sessionStore.save(timeline(1), pausedProjectId);
  await context.sessionStore.save(timeline(1), runningProjectId);
  const worker = new FakeQueueWorker();
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5], maxAttempts: 3 },
  );
  try {
    await queue.start();
    await queue.generateAllImages(pausedProjectId);
    assert.equal(queue.pauseQueue(pausedProjectId).state, "paused");

    await queue.generateAllImages(runningProjectId);
    await waitFor(() => queue.getSnapshot(runningProjectId).state === "idle");

    assert.deepEqual(
      worker.inputs.map((input) => input.outputFolder),
      [projectOutputFolder(runningProjectId)],
    );
    assert.equal(queue.getSnapshot(pausedProjectId).state, "paused");
    assert.equal(queue.getSnapshot(pausedProjectId).queuedJobs, 1);

    await queue.resumeQueue(pausedProjectId);
    await waitFor(() => queue.getSnapshot(pausedProjectId).state === "idle");
    assert.deepEqual(
      worker.inputs.map((input) => input.outputFolder),
      [projectOutputFolder(runningProjectId), projectOutputFolder(pausedProjectId)],
    );
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("resuming repairs a missing continuation frame before queueing its video", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.connected = false;
  const original = await context.sessionStore.load();
  assert.ok(original);
  const planned = await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((scene, index) => index === 0
      ? { ...scene, chainId: "resume-chain", chainRole: "start" as const }
      : { ...scene, chainId: "resume-chain", chainRole: "continue" as const }),
  });
  syncTimelineSessionToProject(context.database, planned, []);
  const repositories = new ProjectRepositories(context.database);
  const [first, continued] = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  const previousVideo = join(context.directory, "scene-001.mp4");
  await writeFile(previousVideo, "fake-video");
  context.database.db.prepare(
    "UPDATE scenes SET status = 'video_done', video_asset_path = ?, approved_video = 1 WHERE id = ?",
  ).run(previousVideo, first.id);
  context.database.db.prepare(
    "UPDATE scenes SET status = 'prompt_ready', start_frame_asset_path = NULL, image_asset_path = NULL, approved_image = 0, approved_video = 0 WHERE id = ?",
  ).run(continued.id);
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
  );
  try {
    await queue.start();
    queue.stopQueue();
    queue.resumeQueue();
    await waitFor(() => context.database.db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE scene_id = ? AND job_type = 'extract_last_frame' AND status = 'queued'",
    ).get(continued.id)?.count === 1);
    assert.equal(
      context.database.db.prepare(
        "SELECT depends_on FROM jobs WHERE scene_id = ? AND job_type = 'extract_last_frame' ORDER BY created_at DESC LIMIT 1",
      ).get(continued.id)?.depends_on,
      null,
    );
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("uses the previous clip final frame directly for continuation video", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.resultDirectory = context.directory;
  worker.persistResults = true;
  const original = await context.sessionStore.load();
  assert.ok(original);
  await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((scene, index) => ({
      ...scene,
      timeStart: index === 0 ? "00:00:00,000" : "00:00:06,000",
      timeEnd: index === 0 ? "00:00:06,000" : "00:00:10,000",
      chainId: "chain-a",
      chainRole: index === 0 ? "start" as const : "continue" as const,
      durationSeconds: index === 0 ? 6 as const : 4 as const,
    })),
  });
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      retryBackoffMs: [5],
      extractLastFrame: async (_videoPath, outputPath) => {
        await writeFile(outputPath, "fake-png-frame");
      },
    },
  );
  try {
    await queue.start();
    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, [
      "scene-001:image",
      "scene-001:video",
      "scene-002:video",
    ]);
    const firstVideo = worker.inputs.find((input) =>
      input.sceneId === "scene-001" && input.mediaType === "video");
    const continuedVideo = worker.inputs.find((input) =>
      input.sceneId === "scene-002" && input.mediaType === "video");
    assert.equal(firstVideo?.videoSettings.mode, "first-frame");
    assert.equal(firstVideo?.videoSettings.durationSeconds, 6);
    assert.equal(continuedVideo?.videoSettings.mode, "first-frame");
    assert.equal(continuedVideo?.videoSettings.durationSeconds, 4);
    assert.equal(continuedVideo?.startFramePath, "");
    assert.equal(continuedVideo?.refImages.length, 0);
    assert.match(continuedVideo?.sourceImagePath || "", /\.kc-frames[\\/].+-last-frame\.png$/);
    assert.equal(continuedVideo?.sourceFlowAssetKey, "");

    const extractJob = context.database.db.prepare(
      "SELECT status FROM jobs WHERE job_type = 'extract_last_frame'",
    ).get() as { status: string };
    assert.equal(extractJob.status, "succeeded");
    const updatedSession = await context.sessionStore.load();
    assert.match(
      updatedSession?.scenes[1].actualContinuityFrame?.path || "",
      /\.kc-frames[\\/].+-last-frame\.png$/,
    );
    assert.equal(updatedSession?.scenes[1].actualContinuityFrame?.fileSize, 14);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("regenerating an upstream video replaces its files and rebuilds continuation from a fresh final frame", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const generatedRoot = join(context.directory, "Downloads", STORAGE_FOLDER_NAME);
  const projectDirectory = join(generatedRoot, projectOutputFolder(DEFAULT_PROJECT_ID));
  await mkdir(projectDirectory, { recursive: true });
  worker.resultDirectory = projectDirectory;
  worker.persistResults = true;
  const original = await context.sessionStore.load();
  assert.ok(original);
  await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((scene, index) => ({
      ...scene,
      timeStart: index === 0 ? "00:00:00,000" : "00:00:06,000",
      timeEnd: index === 0 ? "00:00:06,000" : "00:00:10,000",
      chainId: "replace-chain",
      chainRole: index === 0 ? "start" as const : "continue" as const,
      durationSeconds: index === 0 ? 6 as const : 4 as const,
    })),
  });
  let extracted = 0;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      generatedMediaRoot: generatedRoot,
      retryBackoffMs: [5],
      extractLastFrame: async (_videoPath, outputPath) => {
        extracted += 1;
        await writeFile(outputPath, `fresh-frame-${extracted}`);
      },
    },
  );
  try {
    await queue.start();
    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");
    const completedSnapshot = queue.getSnapshot();
    const completedSession = await context.sessionStore.load();
    assert.ok(completedSession);
    await context.sessionStore.save({
      ...completedSession,
      scenes: completedSession.scenes.map((storedScene) => {
        const completed = completedSnapshot.scenes.find((scene) => scene.sceneId === storedScene.id);
        assert.ok(completed);
        return {
          ...storedScene,
          imageStatus: completed.imageAssetPath ? "done" as const : "pending" as const,
          imageResultPath: completed.imageAssetPath,
          imageFlowAssetKey: completed.flowImageAssetId,
          imageApproved: completed.approvedImage,
          videoStatus: completed.videoAssetPath ? "done" as const : "pending" as const,
          videoResultPath: completed.videoAssetPath,
          videoApproved: completed.approvedVideo,
        };
      }),
    });
    const initialContinuation = completedSnapshot.scenes.find((scene) => scene.sceneId === "scene-002");
    assert.ok(initialContinuation?.imageAssetPath);
    assert.equal(await readFile(initialContinuation.imageAssetPath, "utf8"), "fresh-frame-1");

    queue.stopQueue();
    await queue.regenerateScene("scene-001", "video", DEFAULT_PROJECT_ID);
    await waitFor(() => worker.calls.length === 5 && queue.getSnapshot().state === "stopped", 4_000);

    assert.deepEqual(worker.calls, [
      "scene-001:image",
      "scene-001:video",
      "scene-002:video",
      "scene-001:video",
      "scene-002:video",
    ]);
    const replacedContinuation = queue.getSnapshot().scenes.find((scene) => scene.sceneId === "scene-002");
    assert.ok(replacedContinuation?.imageAssetPath);
    assert.equal(await readFile(replacedContinuation.imageAssetPath, "utf8"), "fresh-frame-2");
    assert.equal(extracted, 2);
    const extractJobs = context.database.db.prepare(
      "SELECT status FROM jobs WHERE job_type = 'extract_last_frame'",
    ).all() as Array<{ status: string }>;
    assert.equal(extractJobs.length, 1);
    assert.equal(extractJobs[0].status, "succeeded");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("a newly queued upstream video discards a stale continuation frame before moving to other scenes", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const generatedRoot = join(context.directory, "Downloads", STORAGE_FOLDER_NAME);
  const projectDirectory = join(generatedRoot, projectOutputFolder(DEFAULT_PROJECT_ID));
  await mkdir(projectDirectory, { recursive: true });
  const openingImage = join(projectDirectory, "scene-001-opening.png");
  const staleFrame = join(projectDirectory, "scene-035-stale-frame.png");
  const staleContinuationVideo = join(projectDirectory, "scene-036-stale.mp4");
  await Promise.all([
    writeFile(openingImage, "opening"),
    writeFile(staleFrame, "stale-frame"),
    writeFile(staleContinuationVideo, "stale-video"),
  ]);
  worker.resultDirectory = projectDirectory;
  worker.persistResults = true;

  const original = await context.sessionStore.load();
  assert.ok(original);
  const withStaleContinuation = await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((scene, index) => index === 0
      ? {
          ...scene,
          chainId: "stale-chain",
          chainRole: "start" as const,
          imageStatus: "done" as const,
          imageResultPath: openingImage,
          imageFlowAssetKey: "flow:opening",
          imageApproved: true,
          videoStatus: "pending" as const,
          videoResultPath: "",
          videoApproved: false,
        }
      : {
          ...scene,
          chainId: "stale-chain",
          chainRole: "continue" as const,
          imagePrompt: "",
          imageStatus: "done" as const,
          imageResultPath: staleFrame,
          imageFlowAssetKey: "",
          imageApproved: true,
          videoStatus: "done" as const,
          videoResultPath: staleContinuationVideo,
          videoApproved: false,
        }),
  });
  syncTimelineSessionToProject(context.database, withStaleContinuation, []);
  const repositories = new ProjectRepositories(context.database);
  const [, continued] = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  repositories.scenes.setStartFrameAssetPath(continued.id, staleFrame);

  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      generatedMediaRoot: generatedRoot,
      extractLastFrame: async (_videoPath, outputPath) => {
        await writeFile(outputPath, "replacement-frame");
      },
    },
  );
  try {
    await queue.start();
    await queue.generateAllVideos(DEFAULT_PROJECT_ID, { onlyApprovedImages: true });
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, ["scene-001:video", "scene-002:video"]);
    await assert.rejects(access(staleFrame));
    await assert.rejects(access(staleContinuationVideo));
    const refreshed = queue.getSnapshot().scenes.find((scene) => scene.sceneId === "scene-002");
    assert.ok(refreshed?.imageAssetPath);
    assert.notEqual(refreshed.imageAssetPath, staleFrame);
    assert.equal(await readFile(refreshed.imageAssetPath, "utf8"), "replacement-frame");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("rebuilds a clean automatic pipeline after an older image-only queue was stopped", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  syncTimelineSessionToProject(context.database, (await context.sessionStore.load())!, []);
  const repositories = new ProjectRepositories(context.database);
  const [first, second] = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  const firstQueued = repositories.scenes.transition({
    sceneId: first.id,
    to: "image_queued",
    jobType: "image_generation",
    payloadHash: "old-first-image",
  });
  repositories.jobs.updateStatus(firstQueued.job.id, "running", { attempts: 1 });
  repositories.scenes.updateState({ sceneId: first.id, to: "image_generating" });
  repositories.jobs.updateStatus(firstQueued.job.id, "succeeded");
  repositories.scenes.updateState({
    sceneId: first.id,
    to: "image_done",
    imageAssetPath: "C:\\FlowX\\scene-001.png",
    flowImageAssetId: "asset:scene-001",
  });
  const staleSecond = repositories.scenes.transition({
    sceneId: second.id,
    to: "image_queued",
    jobType: "image_generation",
    payloadHash: "stale-second-image",
  });
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [5] },
  );
  try {
    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.equal(repositories.jobs.get(staleSecond.job.id), null);
    assert.deepEqual(worker.calls, [
      "scene-001:image",
      "scene-001:video",
      "scene-002:image",
      "scene-002:video",
    ]);
    assert.equal(queue.getSnapshot().queuedJobs, 0);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("runs scenes sequentially, retries with backoff, and auto-enqueues approved videos", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.failFirstSceneOnce = true;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { retryBackoffMs: [30, 60, 90], watchdogIntervalMs: 20, heartbeatTimeoutMs: 500 },
  );
  try {
    await queue.start();
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");

    assert.deepEqual(worker.calls, [
      "scene-001:image",
      "scene-002:image",
      "scene-001:image",
    ]);
    const firstPass = queue.getSnapshot();
    assert.equal(firstPass.errors.length, 0);
    assert.ok(firstPass.scenes.every((scene) => scene.status === "image_done"));
    const firstJob = firstPass.jobs.find((job) => job.sceneId === "scene-001");
    assert.equal(firstJob?.attempts, 2);

    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.regenerateScene("scene-001", "image", DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "idle");
    assert.deepEqual(worker.calls.slice(-2), ["scene-001:image", "scene-001:video"]);
    const autoApproved = queue.getSnapshot().scenes[0];
    assert.equal(autoApproved.approvedImage, true);
    assert.equal(autoApproved.status, "video_submitted");
    assert.equal(autoApproved.videoAssetPath, "");
    const imageJob = queue.getSnapshot().jobs.filter((job) =>
      job.sceneId === "scene-001" && job.mediaType === "image").at(-1)!;
    const videoJob = queue.getSnapshot().jobs.filter((job) =>
      job.sceneId === "scene-001" && job.mediaType === "video").at(-1)!;
    assert.equal(videoJob.dependsOn, imageJob.id);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("does not dequeue a dependent job before its parent succeeds", async () => {
  const context = await fixture();
  try {
    const session = await context.sessionStore.load();
    assert.ok(session);
    syncTimelineSessionToProject(context.database, session, []);
    const repositories = new ProjectRepositories(context.database);
    const scene = repositories.scenes.listByProject(DEFAULT_PROJECT_ID)[0];
    const createdAt = new Date().toISOString();
    const parent = repositories.jobs.create({
      id: "parent-job",
      projectId: DEFAULT_PROJECT_ID,
      sceneId: scene.id,
      jobType: "image_generation",
      status: "running",
      dependsOn: null,
      attempts: 1,
      maxAttempts: 3,
      lastHeartbeatAt: createdAt,
      lastError: null,
      payloadHash: "parent",
      createdAt,
      updatedAt: createdAt,
    });
    repositories.jobs.create({
      id: "child-job",
      projectId: DEFAULT_PROJECT_ID,
      sceneId: scene.id,
      jobType: "video_generation",
      status: "queued",
      dependsOn: parent.id,
      attempts: 0,
      maxAttempts: 3,
      lastHeartbeatAt: null,
      lastError: null,
      payloadHash: "child",
      createdAt,
      updatedAt: createdAt,
    });
    assert.equal(repositories.jobs.nextRunnable(DEFAULT_PROJECT_ID), null);
    repositories.jobs.updateStatus(parent.id, "succeeded");
    assert.equal(repositories.jobs.nextRunnable(DEFAULT_PROJECT_ID)?.id, "child-job");
  } finally {
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("marks a job stuck without heartbeat as timeout_no_response", async () => {
  const context = await fixture();
  const worker = new StuckQueueWorker();
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    {
      maxAttempts: 1,
      heartbeatTimeoutMs: 25,
      watchdogIntervalMs: 5,
      retryBackoffMs: [5],
    },
  );
  try {
    await queue.start();
    await queue.generateAllImages(DEFAULT_PROJECT_ID, {
      onlyStatuses: ["prompt_ready"],
    });
    await waitFor(() => queue.getSnapshot().errors.length > 0);
    const error = queue.getSnapshot().errors[0];
    assert.equal(error.category, "timeout_no_response");
    assert.equal(error.attempts, 1);
    assert.equal(error.retryable, false);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("manual media completion supersedes an older queued job before approve or reject", async () => {
  const context = await fixture();
  const original = await context.sessionStore.load();
  assert.ok(original);
  syncTimelineSessionToProject(context.database, original, []);
  const repositories = new ProjectRepositories(context.database);
  const scene = repositories.scenes.listByProject(DEFAULT_PROJECT_ID)[0];
  const queued = repositories.scenes.transition({
    sceneId: scene.id,
    to: "image_queued",
    jobType: "image_generation",
    payloadHash: "older-queued-job",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await context.sessionStore.save({
    ...original,
    scenes: original.scenes.map((item, index) => index === 0 ? {
      ...item,
      imageStatus: "pending",
      imageResultPath: "C:\\FlowX\\scene-001-manual.png",
      imageFlowAssetKey: "manual:scene-001",
    } : item),
  });

  const worker = new FakeQueueWorker();
  worker.connected = false;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
  );
  try {
    await queue.start();
    const approved = await queue.approveScene("scene-001", "image", DEFAULT_PROJECT_ID);
    assert.equal(repositories.jobs.get(queued.job.id)?.status, "succeeded");
    assert.equal(approved.scenes[0].status, "image_approved");
    assert.equal(approved.scenes[0].approvedImage, true);

    const rejected = await queue.rejectScene("scene-001", "image", DEFAULT_PROJECT_ID);
    assert.equal(rejected.scenes[0].status, "needs_review");
    assert.equal(rejected.scenes[0].approvedImage, false);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("recovers a running job after reopening without creating a duplicate", async () => {
  const context = await fixture();
  const session = await context.sessionStore.load();
  assert.ok(session);
  syncTimelineSessionToProject(context.database, session, []);
  let repositories = new ProjectRepositories(context.database);
  const scene = repositories.scenes.listByProject(DEFAULT_PROJECT_ID)[0];
  const queued = repositories.scenes.transition({
    sceneId: scene.id,
    to: "image_queued",
    jobType: "image_generation",
    payloadHash: "crash-test",
  });
  repositories.jobs.updateStatus(queued.job.id, "running", {
    attempts: 1,
    heartbeatAt: new Date().toISOString(),
  });
  repositories.scenes.updateState({ sceneId: scene.id, to: "image_generating" });
  context.database.close();

  const reopened = new ProjectDatabase(join(context.directory, "flowx.sqlite"));
  await reopened.initialize();
  const worker = new FakeQueueWorker();
  worker.connected = false;
  const queue = new ProductionQueue(
    reopened,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { disconnectedPollMs: 50, watchdogIntervalMs: 20 },
  );
  try {
    await queue.start();
    repositories = new ProjectRepositories(reopened);
    assert.equal(repositories.jobs.get(queued.job.id)?.status, "queued");
    assert.equal(repositories.scenes.get(scene.id)?.status, "image_queued");
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    assert.equal(
      repositories.jobs.listByScene(scene.id).filter((job) => job.jobType === "image_generation").length,
      1,
    );
    assert.equal(queue.pauseQueue().state, "paused");
    assert.equal(queue.resumeQueue().state, "running");
    assert.equal(queue.stopQueue().state, "stopped");
  } finally {
    queue.shutdown();
    reopened.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("persists an explicit stop so reopening does not auto-resume queued work", async () => {
  const context = await fixture();
  const firstWorker = new FakeQueueWorker();
  firstWorker.connected = false;
  const firstQueue = new ProductionQueue(
    context.database,
    firstWorker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { disconnectedPollMs: 20 },
  );
  await firstQueue.start();
  await firstQueue.generateAllImages(DEFAULT_PROJECT_ID);
  assert.equal(firstQueue.stopQueue().state, "stopped");
  firstQueue.shutdown();
  context.database.close();

  const reopened = new ProjectDatabase(join(context.directory, "flowx.sqlite"));
  await reopened.initialize();
  const secondWorker = new FakeQueueWorker();
  const secondQueue = new ProductionQueue(
    reopened,
    secondWorker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { disconnectedPollMs: 20 },
  );
  try {
    await secondQueue.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(secondQueue.getSnapshot().state, "stopped");
    assert.equal(secondQueue.getSnapshot().queuedJobs, 2);
    assert.deepEqual(secondWorker.calls, []);
  } finally {
    secondQueue.shutdown();
    reopened.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("regenerate only one scene does not wake other stopped jobs and may chain its own video", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  worker.connected = false;
  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { disconnectedPollMs: 10 },
  );
  try {
    await queue.start();
    await queue.generateAllImages(DEFAULT_PROJECT_ID);
    queue.stopQueue();
    worker.connected = true;

    await queue.regenerateScene("scene-002", "image", DEFAULT_PROJECT_ID);
    await waitFor(() => queue.getSnapshot().state === "stopped");
    assert.deepEqual(worker.calls, ["scene-002:image"]);
    assert.equal(queue.getSnapshot().queuedJobs, 1);

    queue.setApprovalPolicy(true, false, DEFAULT_PROJECT_ID);
    await queue.regenerateScene("scene-001", "image", DEFAULT_PROJECT_ID);
    await waitFor(() => worker.calls.includes("scene-001:video"));
    await waitFor(() => queue.getSnapshot().state === "stopped");
    assert.deepEqual(worker.calls, [
      "scene-002:image",
      "scene-001:image",
      "scene-001:video",
    ]);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("deletes one scene result while preserving its Phase 3 prompt and other scene media", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const generatedRoot = join(context.directory, "Downloads", STORAGE_FOLDER_NAME);
  const projectDirectory = join(generatedRoot, projectOutputFolder(DEFAULT_PROJECT_ID));
  await mkdir(projectDirectory, { recursive: true });
  const firstImage = join(projectDirectory, "scene-001-image.png");
  const firstVideo = join(projectDirectory, "scene-001-video.mp4");
  const secondImage = join(projectDirectory, "scene-002-image.png");
  await Promise.all([
    writeFile(firstImage, "first-image"),
    writeFile(firstVideo, "first-video"),
    writeFile(secondImage, "second-image"),
  ]);

  const phase3 = await context.sessionStore.load();
  assert.ok(phase3);
  const firstPrompt = phase3.scenes[0].imagePrompt;
  const withResults = await context.sessionStore.save({
    visualBible: phase3.visualBible,
    scenes: phase3.scenes.map((scene, index) => index === 0
      ? {
          ...scene,
          imageStatus: "done" as const,
          imageResultPath: firstImage,
          imageFlowAssetKey: "flow:first",
          imageApproved: true,
          videoStatus: "done" as const,
          videoResultPath: firstVideo,
          videoApproved: true,
        }
      : {
          ...scene,
          imageStatus: "done" as const,
          imageResultPath: secondImage,
          imageFlowAssetKey: "flow:second",
          imageApproved: true,
        }),
  });
  syncTimelineSessionToProject(context.database, withResults, []);
  const repositories = new ProjectRepositories(context.database);
  const storedScenes = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  const timestamp = new Date().toISOString();
  for (const [index, scene] of storedScenes.entries()) {
    repositories.jobs.create({
      id: `completed-image-job-${index + 1}`,
      projectId: DEFAULT_PROJECT_ID,
      sceneId: scene.id,
      jobType: "image_generation",
      status: "succeeded",
      dependsOn: null,
      attempts: 1,
      maxAttempts: 3,
      lastHeartbeatAt: timestamp,
      lastError: null,
      payloadHash: `completed-image-${index + 1}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { generatedMediaRoot: generatedRoot },
  );
  try {
    await queue.start();
    const result = await queue.clearSceneMedia("scene-001", DEFAULT_PROJECT_ID);
    assert.equal(result.sceneId, "scene-001");
    assert.equal(result.deletedFiles, 2);
    await assert.rejects(access(firstImage));
    await assert.rejects(access(firstVideo));
    await access(secondImage);

    const snapshotFirst = result.snapshot.scenes.find((scene) => scene.sceneId === "scene-001");
    const snapshotSecond = result.snapshot.scenes.find((scene) => scene.sceneId === "scene-002");
    assert.equal(snapshotFirst?.status, "prompt_ready");
    assert.equal(snapshotFirst?.imageAssetPath, "");
    assert.equal(snapshotFirst?.videoAssetPath, "");
    assert.equal(snapshotSecond?.imageAssetPath, secondImage);
    assert.equal(result.snapshot.jobs.some((job) => job.sceneId === "scene-001"), false);
    assert.equal(result.snapshot.jobs.some((job) => job.sceneId === "scene-002"), true);

    const retained = await context.sessionStore.load();
    assert.ok(retained);
    assert.equal(retained.scenes[0].imagePrompt, firstPrompt);
    assert.equal(retained.scenes[0].imageStatus, "pending");
    assert.equal(retained.scenes[0].imageResultPath, "");
    assert.equal(retained.scenes[1].imageResultPath, secondImage);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("deletes all generated files and jobs while preserving Phase 3 prompts", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const generatedRoot = join(context.directory, "Downloads", STORAGE_FOLDER_NAME);
  const projectDirectory = join(generatedRoot, projectOutputFolder(DEFAULT_PROJECT_ID));
  const frameDirectory = join(projectDirectory, ".kc-frames");
  await mkdir(frameDirectory, { recursive: true });
  const imagePath = join(projectDirectory, "scene-001-100.png");
  const videoPath = join(projectDirectory, "scene-001-200.mp4");
  const framePath = join(frameDirectory, "scene-001-200-last-frame.png");
  const orphanPath = join(projectDirectory, "scene-001-old-copy.png");
  await Promise.all([
    writeFile(imagePath, "image"),
    writeFile(videoPath, "video"),
    writeFile(framePath, "frame"),
    writeFile(orphanPath, "orphan"),
  ]);

  const phase3 = await context.sessionStore.load();
  assert.ok(phase3);
  const phase3ImagePrompts = phase3.scenes.map((scene) => scene.imagePrompt);
  const phase3VideoPrompts = phase3.scenes.map((scene) => scene.videoPrompt);
  const withResults = await context.sessionStore.save({
    visualBible: phase3.visualBible,
    scenes: phase3.scenes.map((scene, index) => index === 0
      ? {
          ...scene,
          imageStatus: "done" as const,
          imageResultPath: imagePath,
          imageFlowAssetKey: "flow:scene-001",
          imageApproved: true,
          videoStatus: "done" as const,
          videoResultPath: videoPath,
          videoApproved: true,
        }
      : scene),
  });
  syncTimelineSessionToProject(context.database, withResults, []);
  const repositories = new ProjectRepositories(context.database);
  const storedScenes = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
  repositories.scenes.setStartFrameAssetPath(storedScenes[1].id, framePath);
  const bible = repositories.visualBibles.listByProject(DEFAULT_PROJECT_ID)[0];
  repositories.visualBibles.setAnchors(bible.id, [imagePath], true);
  const timestamp = new Date().toISOString();
  repositories.jobs.create({
    id: "completed-image-job",
    projectId: DEFAULT_PROJECT_ID,
    sceneId: storedScenes[0].id,
    jobType: "image_generation",
    status: "succeeded",
    dependsOn: null,
    attempts: 1,
    maxAttempts: 3,
    lastHeartbeatAt: timestamp,
    lastError: null,
    payloadHash: "completed-image",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { generatedMediaRoot: generatedRoot },
  );
  try {
    await queue.start();
    const result = await queue.clearGeneratedMedia(DEFAULT_PROJECT_ID);
    assert.equal(result.deletedFiles, 4);
    assert.equal(result.deletedDirectories, 1);
    assert.equal(result.retainedScenes, 2);
    await assert.rejects(access(projectDirectory));
    await access(generatedRoot);
    assert.equal(result.snapshot.jobs.length, 0);
    assert.ok(result.snapshot.scenes.every((scene) =>
      scene.status === "prompt_ready" &&
      !scene.imageAssetPath &&
      !scene.videoAssetPath &&
      !scene.approvedImage &&
      !scene.approvedVideo
    ));

    const retained = await context.sessionStore.load();
    assert.ok(retained);
    assert.deepEqual(retained.scenes.map((scene) => scene.imagePrompt), phase3ImagePrompts);
    assert.deepEqual(retained.scenes.map((scene) => scene.videoPrompt), phase3VideoPrompts);
    assert.deepEqual(retained.visualBible, phase3.visualBible);
    assert.ok(retained.scenes.every((scene) =>
      scene.imageStatus === "pending" &&
      !scene.imageResultPath &&
      scene.videoStatus === "pending" &&
      !scene.videoResultPath
    ));
    const resetScenes = repositories.scenes.listByProject(DEFAULT_PROJECT_ID);
    assert.ok(resetScenes.every((scene) => !scene.startFrameAssetPath));
    assert.deepEqual(repositories.visualBibles.get(bible.id)?.anchorImagePaths, []);
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("clears stale results from one workspace without deleting media shared by another", async () => {
  const context = await fixture();
  const worker = new FakeQueueWorker();
  const generatedRoot = join(context.directory, "Downloads", STORAGE_FOLDER_NAME);
  await mkdir(generatedRoot, { recursive: true });
  const sharedImagePath = join(generatedRoot, "scene-001-legacy.png");
  await writeFile(sharedImagePath, "legacy-image");

  const original = await context.sessionStore.load(DEFAULT_PROJECT_ID);
  assert.ok(original);
  const staleScenes = original.scenes.map((scene, index) => index === 0
    ? {
        ...scene,
        imageStatus: "done" as const,
        imageResultPath: sharedImagePath,
        imageFlowAssetKey: "flow:legacy-scene-001",
        imageApproved: true,
      }
    : scene);
  const savedOriginal = await context.sessionStore.save({
    visualBible: original.visualBible,
    scenes: staleScenes,
  }, DEFAULT_PROJECT_ID);
  syncTimelineSessionToProject(context.database, savedOriginal, []);

  const second = await context.sessionStore.create("Phiên bị dính kết quả cũ");
  const contaminated = await context.sessionStore.save({
    visualBible: original.visualBible,
    scenes: staleScenes,
  }, second.id);
  syncTimelineSessionToProject(context.database, contaminated, []);

  const queue = new ProductionQueue(
    context.database,
    worker,
    context.characterStore,
    context.sessionStore,
    () => {},
    { generatedMediaRoot: generatedRoot },
  );
  try {
    const result = await queue.clearGeneratedMedia(second.id);
    assert.equal(result.deletedFiles, 0);
    await access(sharedImagePath);
    assert.equal(
      (await context.sessionStore.load(DEFAULT_PROJECT_ID))?.scenes[0].imageResultPath,
      sharedImagePath,
    );
    const resetSecond = await context.sessionStore.load(second.id);
    assert.equal(resetSecond?.scenes[0].imageStatus, "pending");
    assert.equal(resetSecond?.scenes[0].imageResultPath, "");
  } finally {
    queue.shutdown();
    context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});
