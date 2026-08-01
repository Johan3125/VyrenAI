import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import {
  normalizeTimelineResult,
  validateGeneratedVisualBible,
  validateTimelineCoverage,
  type JobProgressStatus,
  type PolicyPromptRewriteInput,
  type PolicyPromptRewriteResult,
  type TimelineGenerateInput,
  type TimelineProgress,
  type TimelineResult,
} from "../shared/timeline";
import {
  normalizeSceneJobResult,
  type BoundSceneJobInput,
  type SceneJobProgress,
  type SceneJobResult,
} from "../shared/scene-job";
import {
  createDisconnectedStatuses,
  createDisconnectedWorkerStatus,
  normalizeWorkerCapabilities,
  WORKER_PROVIDER_BY_ROLE,
  WORKER_ROLES,
  type WorkerAction,
  type WorkerProvider,
  type WorkerRole,
  type WorkerStatuses,
} from "../shared/worker-status";
import { APP_BRAND_NAME, EXTENSION_DISPLAY_NAME } from "../shared/brand";
import {
  normalizeTextProvider,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
} from "../shared/provider";

export const WORKER_SERVER_HOST = "127.0.0.1";
export const WORKER_SERVER_PORT = 17890;

const REGISTER_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const CONNECTION_TIMEOUT_MS = 45_000;
// Phase 5 sends reference images as base64. Four 10 MB library images plus
// JSON/base64 overhead fit below this local-only WebSocket limit.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const JOB_TIMEOUT_MS = 90 * 60 * 1_000;
const JOB_ACK_TIMEOUT_MS = 12_000;

interface WorkerServerOptions {
  host?: string;
  port?: number;
  registerTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  connectionTimeoutMs?: number;
  jobTimeoutMs?: number;
  jobAckTimeoutMs?: number;
}

interface ClientState {
  id: string;
  socket: WebSocket;
  role: WorkerRole | null;
  profileTag: string | null;
  workerVersion: string | null;
  provider: WorkerProvider | null;
  capabilities: WorkerAction[];
  connectedAt: string | null;
  lastSeenAt: number;
  registrationTimer: NodeJS.Timeout;
}

interface RegisterMessage {
  type: "REGISTER";
  role: WorkerRole;
  profileTag: string;
  workerVersion: string | null;
  provider: WorkerProvider;
  capabilities: WorkerAction[];
}

type PendingWorkerAction = Extract<
  WorkerAction,
  | "GENERATE_TIMELINE"
  | "REWRITE_POLICY_PROMPT"
  | "GENERATE_IMAGE"
  | "GENERATE_CHATGPT_IMAGE"
  | "GENERATE_VIDEO"
  | "GENERATE_PROVIDER_IMAGE"
  | "GENERATE_PROVIDER_VIDEO"
>;

interface PendingJob {
  id: string;
  role: WorkerRole;
  action: PendingWorkerAction;
  client: ClientState;
  input: TimelineGenerateInput | PolicyPromptRewriteInput | BoundSceneJobInput;
  timer: NodeJS.Timeout;
  ackTimer: NodeJS.Timeout;
  onProgress: (progress: any) => void;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class WorkerJobError extends Error {
  constructor(
    message: string,
    readonly code = "INTERNAL_ERROR",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkerJobError";
  }
}

function isWorkerRole(value: unknown): value is WorkerRole {
  return WORKER_ROLES.includes(value as WorkerRole);
}

function workerVersionNumber(value: string | null): number {
  if (!value) return 0;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] || 0) * 1_000_000 + (parts[1] || 0) * 1_000 + (parts[2] || 0);
}

function supportsTimelineWorker(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_044_000;
}

function supportsDirectVideoTimelineWorker(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_061_000;
}

function supportsSceneJobs(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_047_000;
}

function supportsChatGptImageJobs(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_055_000;
}

function supportsProviderMediaJobs(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_058_000;
}

function supportsTextToVideoJobs(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_060_000;
}

function supportsPolicyPromptRewrite(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_032_000;
}

function supportsSingleNativeVideoDownload(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_042_000;
}

function supportsSubmitOnlyVideoJobs(value: string | null): boolean {
  return workerVersionNumber(value) >= 2_062_000;
}

function normalizePolicyPromptRewriteResult(
  value: unknown,
  input: PolicyPromptRewriteInput,
): PolicyPromptRewriteResult {
  const providerLabel = TEXT_PROVIDER_LABEL[normalizeTextProvider(input.textProvider)];
  if (!value || typeof value !== "object") {
    throw new Error(`${providerLabel} không trả về prompt thay thế hợp lệ`);
  }
  const prompt = typeof (value as Record<string, unknown>).prompt === "string"
    ? String((value as Record<string, unknown>).prompt).trim()
    : "";
  const wordCount = prompt ? prompt.split(/\s+/).length : 0;
  const requiredSections = input.mediaType === "image"
    ? ["SUBJECT AND ACTION:", "EMOTION AND BODY LANGUAGE:", "SETTING AND BACKGROUND:", "DEPTH LAYERS:", "CAMERA AND COMPOSITION:"]
    : ["STARTING STATE:", "PRIMARY MOTION:", "REACTION:", "ENVIRONMENTAL MOTION:", "CAMERA MOTION:", "END FRAME:"];
  if (
    wordCount < 50 ||
    wordCount > 180 ||
    requiredSections.some((section) => !prompt.toUpperCase().includes(section))
  ) {
    throw new Error(`Prompt ${providerLabel} sửa lại không đạt cấu trúc hoặc độ dài yêu cầu`);
  }
  return { prompt };
}

function parseRegisterMessage(value: unknown): RegisterMessage | null {
  if (!value || typeof value !== "object") return null;

  const message = value as Record<string, unknown>;
  if (
    message.type !== "REGISTER" ||
    !isWorkerRole(message.role) ||
    typeof message.profileTag !== "string"
  ) {
    return null;
  }

  const profileTag = message.profileTag.trim();
  if (!profileTag || profileTag.length > 80) return null;
  const workerVersion =
    typeof message.workerVersion === "string"
      ? message.workerVersion.trim().slice(0, 20)
      : null;

  const role = message.role;
  const expectedProvider = WORKER_PROVIDER_BY_ROLE[role];
  const provider = message.provider === undefined
    ? expectedProvider
    : message.provider === expectedProvider
      ? expectedProvider
      : null;
  if (!provider) return null;
  const capabilities = normalizeWorkerCapabilities(message.capabilities, role);
  return {
    type: "REGISTER",
    role,
    profileTag,
    workerVersion,
    provider,
    capabilities,
  };
}

export class WorkerServer {
  private server: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Set<ClientState>();
  private readonly clientsByRole = new Map<WorkerRole, Set<ClientState>>();
  private readonly statuses = createDisconnectedStatuses();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly activeJobsByClient = new Map<ClientState, PendingJob>();
  private readonly options: Required<WorkerServerOptions>;

  constructor(
    private readonly onStatusChange: (statuses: WorkerStatuses) => void,
    options: WorkerServerOptions = {},
  ) {
    this.options = {
      host: options.host ?? WORKER_SERVER_HOST,
      port: options.port ?? WORKER_SERVER_PORT,
      registerTimeoutMs: options.registerTimeoutMs ?? REGISTER_TIMEOUT_MS,
      heartbeatIntervalMs:
        options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      connectionTimeoutMs:
        options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
      jobTimeoutMs: options.jobTimeoutMs ?? JOB_TIMEOUT_MS,
      jobAckTimeoutMs: options.jobAckTimeoutMs ?? JOB_ACK_TIMEOUT_MS,
    };
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        maxPayload: MAX_MESSAGE_BYTES,
      });

      const handleStartupError = (error: Error) => {
        server.removeListener("listening", handleListening);
        this.server = null;
        reject(error);
      };
      const handleListening = () => {
        server.removeListener("error", handleStartupError);
        this.server = server;
        this.heartbeatTimer = setInterval(
          () => this.runHeartbeat(),
          this.options.heartbeatIntervalMs,
        );
        resolve();
      };

      server.once("error", handleStartupError);
      server.once("listening", handleListening);
      server.on("connection", (socket) => this.handleConnection(socket));
      server.on("error", (error) => {
        console.error(`[${APP_BRAND_NAME}] WebSocket server error:`, error);
      });
    });
  }

  getStatuses(): WorkerStatuses {
    return structuredClone(this.statuses);
  }

  getListeningPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  getAvailableSlots(role: WorkerRole): number {
    return this.connectedClientsForRole(role)
      .filter((client) => !this.activeJobsByClient.has(client))
      .length;
  }

  generateTimeline(
    input: TimelineGenerateInput,
    onProgress: (progress: TimelineProgress) => void = () => {},
  ): Promise<TimelineResult> {
    return this.dispatchTimelineJob(input, onProgress);
  }

  rewritePolicyPrompt(
    input: PolicyPromptRewriteInput,
    onProgress: (progress: TimelineProgress) => void = () => {},
  ): Promise<PolicyPromptRewriteResult> {
    return this.dispatchPolicyPromptRewrite(input, onProgress);
  }

  runSceneJob(
    input: BoundSceneJobInput,
    onProgress: (progress: SceneJobProgress) => void = () => {},
  ): Promise<SceneJobResult> {
    return this.dispatchSceneJob(input, onProgress);
  }

  stopActiveJob(role: WorkerRole, jobId?: string): boolean {
    const job = jobId
      ? this.pendingJobs.get(jobId) || null
      : [...this.activeJobsByClient.values()].find((entry) => entry.role === role) || null;
    if (job?.role !== role) return false;
    if (!job) return false;

    job.onProgress({
      jobId: job.id,
      status: "stopping",
      message: "Đang yêu cầu worker dừng công việc",
    });
    if (job.client.socket.readyState === WebSocket.OPEN) {
      job.client.socket.send(JSON.stringify({ type: "STOP", jobId: job.id }));
    }
    this.finishJob(
      job,
      new WorkerJobError("Timeline generation stopped", "STOPPED"),
    );
    return true;
  }

  stopActiveTimelineJob(): boolean {
    for (const job of this.activeJobsByClient.values()) {
      if (job.action === "GENERATE_TIMELINE") {
        return this.stopActiveJob(job.role, job.id);
      }
    }
    return false;
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients) {
      clearTimeout(client.registrationTimer);
      client.socket.terminate();
    }
    this.clients.clear();
    this.clientsByRole.clear();
    for (const job of this.pendingJobs.values()) {
      clearTimeout(job.timer);
      clearTimeout(job.ackTimer);
      job.reject(new WorkerJobError("Desktop app is stopping", "STOPPED"));
    }
    this.pendingJobs.clear();
    this.activeJobsByClient.clear();

    this.server?.close();
    this.server = null;
  }

  private handleConnection(socket: WebSocket): void {
    const client: ClientState = {
      id: randomUUID(),
      socket,
      role: null,
      profileTag: null,
      workerVersion: null,
      provider: null,
      capabilities: [],
      connectedAt: null,
      lastSeenAt: Date.now(),
      registrationTimer: setTimeout(() => {
        socket.close(1008, "REGISTER required");
      }, this.options.registerTimeoutMs),
    };
    this.clients.add(client);

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, "JSON text messages only");
        return;
      }

      client.lastSeenAt = Date.now();

      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1007, "Invalid JSON");
        return;
      }

      if (!client.role) {
        const registration = parseRegisterMessage(message);
        if (!registration) {
          socket.close(1008, "First message must be REGISTER");
          return;
        }
        this.registerClient(client, registration);
        return;
      }

      if (this.handleWorkerMessage(client, message)) {
        return;
      }

      console.warn(
        `[${APP_BRAND_NAME}] Ignored unsupported message from ${client.role}`,
      );
    });

    socket.on("close", () => this.handleClose(client));
    socket.on("error", (error) => {
      console.warn(`[${APP_BRAND_NAME}] Worker socket error:`, error.message);
    });
  }

  private registerClient(
    client: ClientState,
    registration: RegisterMessage,
  ): void {
    clearTimeout(client.registrationTimer);

    const roleClients = this.roleClientSet(registration.role);
    const previousSameProfile = [...roleClients].find((existing) =>
      existing !== client && existing.profileTag === registration.profileTag
    );
    if (previousSameProfile) {
      const activeJob = this.activeJobsByClient.get(previousSameProfile);
      const incomingVersion = workerVersionNumber(registration.workerVersion);
      const currentVersion = workerVersionNumber(previousSameProfile.workerVersion);
      if (activeJob || incomingVersion < currentVersion) {
        client.socket.close(
          4002,
          activeJob ? "Worker profile is busy" : "Older worker profile rejected",
        );
        return;
      }
      this.removeClientFromRole(previousSameProfile);
    }
    client.role = registration.role;
    client.profileTag = registration.profileTag;
    client.workerVersion = registration.workerVersion;
    client.provider = registration.provider;
    client.capabilities = [...registration.capabilities];
    client.connectedAt = new Date().toISOString();
    this.roleClientSet(registration.role).add(client);

    if (previousSameProfile) {
      if (previousSameProfile.socket.readyState === WebSocket.OPEN) {
        previousSameProfile.socket.send(JSON.stringify({ type: "STOP" }), () => {
          previousSameProfile.socket.close(4001, "Replaced by newer worker");
        });
      } else {
        previousSameProfile.socket.close(4001, "Replaced by newer worker");
      }
    }

    // A browser service worker can outlive the desktop process. After an app
    // restart it may still hold a job that no server instance can identify.
    // STOP without a jobId clears only that orphaned worker-local operation.
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify({ type: "STOP" }));
      this.pingClient(client, Date.now());
    }

    this.updateRoleStatus(registration.role);
    this.emitStatuses();

    console.info(
      `[${APP_BRAND_NAME}] Registered ${registration.role} (${registration.profileTag}, v${registration.workerVersion || "legacy"})`,
    );
  }

  private handleClose(client: ClientState): void {
    clearTimeout(client.registrationTimer);
    this.clients.delete(client);
    if (!client.role) return;

    this.removeClientFromRole(client);
    const activeJob = this.activeJobsByClient.get(client);
    if (activeJob) {
      this.finishJob(
        activeJob,
        new WorkerJobError(
          `${client.role} disconnected while processing the job`,
          "INTERNAL_ERROR",
          true,
        ),
      );
    }
    this.updateRoleStatus(client.role);
    this.emitStatuses();
  }

  private runHeartbeat(): void {
    const now = Date.now();

    for (const client of this.clients) {
      if (!client.role) continue;
      if (now - client.lastSeenAt > this.options.connectionTimeoutMs) {
        client.socket.terminate();
        continue;
      }

      this.pingClient(client, now);
    }
  }

  private pingClient(client: ClientState, timestamp: number): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify({ type: "PING", timestamp }));
    }
  }

  private emitStatuses(): void {
    this.onStatusChange(this.getStatuses());
  }

  private roleClientSet(role: WorkerRole): Set<ClientState> {
    let clients = this.clientsByRole.get(role);
    if (!clients) {
      clients = new Set<ClientState>();
      this.clientsByRole.set(role, clients);
    }
    return clients;
  }

  private connectedClientsForRole(role: WorkerRole): ClientState[] {
    return [...(this.clientsByRole.get(role) || [])].filter(
      (client) => client.socket.readyState === WebSocket.OPEN,
    );
  }

  private removeClientFromRole(client: ClientState): void {
    if (!client.role) return;
    const clients = this.clientsByRole.get(client.role);
    if (!clients) return;
    clients.delete(client);
    if (clients.size === 0) this.clientsByRole.delete(client.role);
  }

  private updateRoleStatus(role: WorkerRole): void {
    const clients = this.connectedClientsForRole(role);
    if (clients.length === 0) {
      this.statuses[role] = createDisconnectedWorkerStatus(role);
      return;
    }
    const sorted = [...clients].sort((left, right) =>
      workerVersionNumber(right.workerVersion) - workerVersionNumber(left.workerVersion) ||
      (left.connectedAt || "").localeCompare(right.connectedAt || "") ||
      left.id.localeCompare(right.id)
    );
    const primary = sorted[0];
    const busyCount = clients.filter((client) => this.activeJobsByClient.has(client)).length;
    const capabilities = [...new Set(clients.flatMap((client) => client.capabilities))] as WorkerAction[];
    this.statuses[role] = {
      role,
      connected: true,
      profileTag: primary.profileTag,
      connectedAt: sorted
        .map((client) => client.connectedAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0] || primary.connectedAt,
      provider: WORKER_PROVIDER_BY_ROLE[role],
      capabilities,
      workerVersion: primary.workerVersion,
      connectedCount: clients.length,
      busyCount,
      idleCount: Math.max(0, clients.length - busyCount),
    };
  }

  private selectIdleClient(clients: ClientState[]): ClientState | null {
    return [...clients]
      .filter((client) =>
        client.socket.readyState === WebSocket.OPEN &&
        !this.activeJobsByClient.has(client)
      )
      .sort((left, right) =>
        workerVersionNumber(right.workerVersion) - workerVersionNumber(left.workerVersion) ||
        left.lastSeenAt - right.lastSeenAt ||
        left.id.localeCompare(right.id)
      )[0] || null;
  }

  private dispatchTimelineJob(
    input: TimelineGenerateInput,
    onProgress: (progress: TimelineProgress) => void,
  ): Promise<TimelineResult> {
    const provider = normalizeTextProvider(input.textProvider);
    const role: WorkerRole = TEXT_PROVIDER_WORKER_ROLE[provider];
    const providerLabel = TEXT_PROVIDER_LABEL[provider];
    const clients = this.connectedClientsForRole(role);
    if (clients.length === 0) {
      return Promise.reject(
        new WorkerJobError(
          `${providerLabel} worker chưa kết nối`,
          "NOT_LOGGED_IN",
          true,
        ),
      );
    }
    if (!clients.some((client) => client.capabilities.includes("GENERATE_TIMELINE"))) {
      return Promise.reject(
        new WorkerJobError(`${providerLabel} worker không đăng ký năng lực tạo timeline`, "INVALID_JOB"),
      );
    }
    if (!clients.some((client) => supportsTimelineWorker(client.workerVersion))) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ ${providerLabel} timeline worker. Hãy Reload extension mới nhất.`,
          "INVALID_JOB",
        ),
      );
    }
    if (
      input.outputTarget === "video" &&
      input.videoSourceMode === "direct" &&
      !clients.some((client) => supportsDirectVideoTimelineWorker(client.workerVersion))
    ) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ direct-video timeline. Hãy Reload extension mới nhất.`,
          "INVALID_JOB",
        ),
      );
    }
    const capableClients = clients.filter((client) =>
      client.capabilities.includes("GENERATE_TIMELINE") &&
      supportsTimelineWorker(client.workerVersion) &&
      (
        input.outputTarget !== "video" ||
        input.videoSourceMode !== "direct" ||
        supportsDirectVideoTimelineWorker(client.workerVersion)
      )
    );
    const client = this.selectIdleClient(capableClients);
    if (!client) {
      return Promise.reject(
        new WorkerJobError(`${providerLabel} worker đang xử lý timeline khác`, "INVALID_JOB"),
      );
    }

    const jobId = `timeline-${randomUUID()}`;
    return new Promise<TimelineResult>((resolve, reject) => {
      const job: PendingJob = {
        id: jobId,
        role,
        action: "GENERATE_TIMELINE",
        client,
        input,
        onProgress,
        resolve,
        reject,
        ackTimer: setTimeout(() => {
          this.finishJob(
            job,
            new WorkerJobError(
              `Extension không phản hồi. Hãy Reload ${EXTENSION_DISPLAY_NAME} và tải lại trang ${providerLabel}.`,
              "INTERNAL_ERROR",
              true,
            ),
          );
        }, this.options.jobAckTimeoutMs),
        timer: setTimeout(() => {
          this.finishJob(
            job,
            new WorkerJobError(
              `Hết thời gian chờ ${providerLabel}`,
              "TIMEOUT",
              true,
            ),
          );
          if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify({ type: "STOP", jobId }));
          }
        }, this.options.jobTimeoutMs),
      };

      this.pendingJobs.set(jobId, job);
      this.activeJobsByClient.set(client, job);
      this.updateRoleStatus(role);
      this.emitStatuses();
      onProgress({
        jobId,
        status: "queued",
        message: `Đã gửi yêu cầu tới ${providerLabel} worker`,
      });

      client.socket.send(
        JSON.stringify({
          type: "JOB",
          jobId,
          action: job.action,
          payload: input,
        }),
        (error) => {
          if (error) {
            this.finishJob(
              job,
              new WorkerJobError(error.message, "INTERNAL_ERROR", true),
            );
          }
        },
      );
    });
  }

  private dispatchPolicyPromptRewrite(
    input: PolicyPromptRewriteInput,
    onProgress: (progress: TimelineProgress) => void,
  ): Promise<PolicyPromptRewriteResult> {
    const provider = normalizeTextProvider(input.textProvider);
    const role: WorkerRole = TEXT_PROVIDER_WORKER_ROLE[provider];
    const providerLabel = TEXT_PROVIDER_LABEL[provider];
    const clients = this.connectedClientsForRole(role);
    if (clients.length === 0) {
      return Promise.reject(
        new WorkerJobError(`${providerLabel} worker chưa kết nối`, "NOT_LOGGED_IN", true),
      );
    }
    if (!clients.some((client) => client.capabilities.includes("REWRITE_POLICY_PROMPT"))) {
      return Promise.reject(
        new WorkerJobError(`${providerLabel} worker không đăng ký năng lực sửa prompt`, "INVALID_JOB"),
      );
    }
    if (!clients.some((client) => supportsPolicyPromptRewrite(client.workerVersion))) {
      return Promise.reject(
        new WorkerJobError(`${EXTENSION_DISPLAY_NAME} hiện tại chưa hỗ trợ sửa prompt chính sách. Hãy Reload extension.`, "INVALID_JOB"),
      );
    }
    const capableClients = clients.filter((client) =>
      client.capabilities.includes("REWRITE_POLICY_PROMPT") &&
      supportsPolicyPromptRewrite(client.workerVersion)
    );
    const client = this.selectIdleClient(capableClients);
    if (!client) {
      return Promise.reject(
        new WorkerJobError(`${providerLabel} worker đang xử lý công việc khác`, "INVALID_JOB"),
      );
    }

    const jobId = `policy-rewrite-${input.sceneId}-${randomUUID()}`;
    return new Promise<PolicyPromptRewriteResult>((resolve, reject) => {
      const job: PendingJob = {
        id: jobId,
        role,
        action: "REWRITE_POLICY_PROMPT",
        client,
        input,
        onProgress,
        resolve,
        reject,
        ackTimer: setTimeout(() => {
          this.finishJob(
            job,
            new WorkerJobError(`${providerLabel} extension không phản hồi yêu cầu sửa prompt`, "INTERNAL_ERROR", true),
          );
        }, this.options.jobAckTimeoutMs),
        timer: setTimeout(() => {
          this.finishJob(job, new WorkerJobError(`Hết thời gian chờ ${providerLabel} sửa prompt`, "TIMEOUT", true));
          if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify({ type: "STOP", jobId }));
          }
        }, this.options.jobTimeoutMs),
      };
      this.pendingJobs.set(jobId, job);
      this.activeJobsByClient.set(client, job);
      this.updateRoleStatus(role);
      this.emitStatuses();
      onProgress({ jobId, status: "queued", message: `Đang gửi prompt lỗi ${input.sceneId} tới ${providerLabel}` });
      client.socket.send(
        JSON.stringify({ type: "JOB", jobId, action: job.action, payload: input }),
        (error) => {
          if (error) this.finishJob(job, new WorkerJobError(error.message, "INTERNAL_ERROR", true));
        },
      );
    });
  }

  private dispatchSceneJob(
    input: BoundSceneJobInput,
    onProgress: (progress: SceneJobProgress) => void,
  ): Promise<SceneJobResult> {
    const imageProvider = input.imageSettings.provider;
    const videoProvider = input.videoSettings.provider;
    const chatGptImage = input.mediaType === "image" && imageProvider === "chatgpt-image";
    const geminiMedia = input.mediaType === "image"
      ? imageProvider === "gemini-image"
      : videoProvider === "gemini-video";
    const grokMedia = input.mediaType === "image"
      ? imageProvider === "grok-image"
      : videoProvider === "grok-video";
    const capcutMedia = input.mediaType === "video" && videoProvider === "capcut-video";
    const providerMedia = geminiMedia || grokMedia || capcutMedia;
    const role: WorkerRole = chatGptImage
      ? "chat-worker"
      : geminiMedia
        ? "gemini-worker"
        : grokMedia
          ? "grok-worker"
          : capcutMedia
            ? "capcut-worker"
            : "flow-worker";
    const action: PendingWorkerAction = chatGptImage
      ? "GENERATE_CHATGPT_IMAGE"
      : providerMedia
        ? input.mediaType === "image" ? "GENERATE_PROVIDER_IMAGE" : "GENERATE_PROVIDER_VIDEO"
        : input.mediaType === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO";
    const providerLabel = chatGptImage
      ? "ChatGPT"
      : geminiMedia
        ? "Gemini"
        : grokMedia
          ? "Grok"
          : capcutMedia
            ? "CapCut"
            : "Google Flow";
    const clients = this.connectedClientsForRole(role);
    if (clients.length === 0) {
      return Promise.reject(
        new WorkerJobError(
          `${providerLabel} worker chưa kết nối`,
          "NOT_LOGGED_IN",
          true,
        ),
      );
    }
    if (chatGptImage && !clients.some((client) => supportsChatGptImageJobs(client.workerVersion))) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ tạo ảnh bằng ChatGPT. Hãy Reload extension 2.55.0.`,
          "INVALID_JOB",
        ),
      );
    }
    if (providerMedia && (
      !clients.some((client) =>
        supportsProviderMediaJobs(client.workerVersion) &&
        client.capabilities.includes(action)
      )
    )) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ adapter ${providerLabel} ${input.mediaType}. Hãy Reload extension 2.58.0.`,
          "INVALID_JOB",
        ),
      );
    }
    if (
      input.mediaType === "video" &&
      input.videoSettings.mode === "text-to-video" &&
      !clients.some((client) => supportsTextToVideoJobs(client.workerVersion))
    ) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ tạo video trực tiếp từ prompt. Hãy Reload extension 2.60.0.`,
          "INVALID_JOB",
        ),
      );
    }
    if (
      !chatGptImage &&
      !providerMedia &&
      input.mediaType === "video" &&
      input.videoSettings.delivery === "submit-only" &&
      !clients.some((client) => supportsSubmitOnlyVideoJobs(client.workerVersion))
    ) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ chế độ gửi Flow không tải file. Hãy Reload extension 2.62.0.`,
          "INVALID_JOB",
        ),
      );
    }
    if (!chatGptImage && !providerMedia && !clients.some((client) => supportsSceneJobs(client.workerVersion))) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} chưa hỗ trợ checkpoint xác nhận ảnh nhân vật và prompt trước khi Gửi. Hãy Reload extension 2.47.0.`,
          "INVALID_JOB",
        ),
      );
    }
    if (!chatGptImage && !providerMedia && input.mediaType === "video" && !clients.some((client) => supportsSingleNativeVideoDownload(client.workerVersion))) {
      return Promise.reject(
        new WorkerJobError(
          `${EXTENSION_DISPLAY_NAME} ${clients[0]?.workerVersion || "cũ"} vẫn có thể tải trùng video. Hãy Reload extension 2.42.0 trở lên trước khi chạy Video.`,
          "INVALID_JOB",
        ),
      );
    }
    const capableClients = clients.filter((client) => {
      if (!client.capabilities.includes(action)) return false;
      if (chatGptImage) return supportsChatGptImageJobs(client.workerVersion);
      if (providerMedia) {
        if (!supportsProviderMediaJobs(client.workerVersion)) return false;
        return input.mediaType !== "video" ||
          input.videoSettings.mode !== "text-to-video" ||
          supportsTextToVideoJobs(client.workerVersion);
      }
      if (!supportsSceneJobs(client.workerVersion)) return false;
      if (
        input.mediaType === "video" &&
        input.videoSettings.mode === "text-to-video" &&
        !supportsTextToVideoJobs(client.workerVersion)
      ) return false;
      if (
        input.mediaType === "video" &&
        input.videoSettings.delivery === "submit-only" &&
        !supportsSubmitOnlyVideoJobs(client.workerVersion)
      ) return false;
      if (
        input.mediaType === "video" &&
        !supportsSingleNativeVideoDownload(client.workerVersion)
      ) return false;
      return true;
    });
    const client = this.selectIdleClient(capableClients);
    if (!client) {
      return Promise.reject(
        new WorkerJobError(
          `${providerLabel} worker đang xử lý scene khác`,
          "INVALID_JOB",
        ),
      );
    }

    const jobId = `${input.mediaType}-${input.sceneId}-${randomUUID()}`;
    return new Promise<SceneJobResult>((resolve, reject) => {
      const progress = (value: TimelineProgress) =>
        onProgress({
          ...value,
          sceneId: input.sceneId,
          mediaType: input.mediaType,
        });
      const job: PendingJob = {
        id: jobId,
        role,
        action,
        client,
        input,
        onProgress: progress,
        resolve,
        reject,
        ackTimer: setTimeout(() => {
          this.finishJob(
            job,
            new WorkerJobError(
              `${providerLabel} worker không phản hồi scene ${input.mediaType} job`,
              "INTERNAL_ERROR",
              true,
            ),
          );
        }, this.options.jobAckTimeoutMs),
        timer: setTimeout(() => {
          this.finishJob(
            job,
            new WorkerJobError("Scene job timed out", "TIMEOUT", true),
          );
        }, this.options.jobTimeoutMs),
      };

      this.pendingJobs.set(jobId, job);
      this.activeJobsByClient.set(client, job);
      this.updateRoleStatus(role);
      this.emitStatuses();
      progress({
        jobId,
        status: "queued",
        message: `Đã gửi ${input.mediaType} job cho ${input.sceneId}`,
      });
      client.socket.send(
        JSON.stringify({ type: "JOB", jobId, action, payload: input }),
        (error) => {
          if (error) {
            this.finishJob(
              job,
              new WorkerJobError(error.message, "INTERNAL_ERROR", true),
            );
          }
        },
      );
    });
  }

  private handleWorkerMessage(client: ClientState, value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    if (message.type === "PONG") return true;
    if (
      message.type !== "JOB_PROGRESS" &&
      message.type !== "JOB_DONE" &&
      message.type !== "JOB_ERROR"
    ) {
      return false;
    }

    if (typeof message.jobId !== "string") return true;
    const job = this.pendingJobs.get(message.jobId);
    if (!job || job.client !== client) return true;
    clearTimeout(job.ackTimer);

    if (message.type === "JOB_PROGRESS") {
      const allowedStatuses: JobProgressStatus[] = [
        "queued",
        "preparing",
        "generating",
        "downloading",
        "stopping",
      ];
      if (allowedStatuses.includes(message.status as JobProgressStatus)) {
        const progress: Record<string, unknown> = {
          jobId: job.id,
          status: message.status as JobProgressStatus,
          message:
            typeof message.message === "string"
              ? message.message.slice(0, 500)
              : undefined,
        };
        for (const field of ["phase", "provider"]) {
          if (typeof message[field] === "string") {
            progress[field] = String(message[field]).slice(0, 80);
          }
        }
        for (const field of [
          "batchIndex",
          "batchCount",
          "attempt",
          "maxAttempts",
          "sceneCount",
          "totalScenes",
          "elapsedSeconds",
        ]) {
          const number = Number(message[field]);
          if (Number.isFinite(number) && number >= 0) progress[field] = Math.floor(number);
        }
        job.onProgress(progress);
      }
      return true;
    }

    if (message.type === "JOB_ERROR") {
      this.finishJob(
        job,
        new WorkerJobError(
          typeof message.error === "string"
            ? message.error
            : "Worker could not generate the timeline",
          typeof message.code === "string" ? message.code : "INTERNAL_ERROR",
          message.retryable === true,
        ),
      );
      return true;
    }

    try {
      if (job.action === "GENERATE_TIMELINE") {
        const input = job.input as TimelineGenerateInput;
        const result = normalizeTimelineResult(message.result, {
          allowEmptyImagePrompts: input.outputTarget === "video" &&
            input.videoSourceMode === "direct",
        });
        const lockedBible = input.visualBible;
        for (const field of ["style", "palette", "lighting", "continuityNotes"] as const) {
          if (lockedBible[field]?.trim()) {
            result.visualBible[field] = lockedBible[field].trim();
          }
        }
        validateGeneratedVisualBible(result.visualBible);
        validateTimelineCoverage(result, input.srtText);
        this.finishJob(job, null, result);
      } else if (job.action === "REWRITE_POLICY_PROMPT") {
        this.finishJob(
          job,
          null,
          normalizePolicyPromptRewriteResult(
            message.result,
            job.input as PolicyPromptRewriteInput,
          ),
        );
      } else {
        const input = job.input as BoundSceneJobInput;
        this.finishJob(
          job,
          null,
          normalizeSceneJobResult(message.result, input),
        );
      }
    } catch (error) {
      this.finishJob(
        job,
        new WorkerJobError(
          error instanceof Error ? error.message : String(error),
          "INVALID_JOB",
        ),
      );
    }
    return true;
  }

  private finishJob(
    job: PendingJob,
    error: Error | null,
    result?: TimelineResult | PolicyPromptRewriteResult | SceneJobResult,
  ): void {
    if (!this.pendingJobs.has(job.id)) return;

    clearTimeout(job.timer);
    clearTimeout(job.ackTimer);
    this.pendingJobs.delete(job.id);
    if (this.activeJobsByClient.get(job.client) === job) {
      this.activeJobsByClient.delete(job.client);
      this.updateRoleStatus(job.role);
      this.emitStatuses();
    }

    if (error) job.reject(error);
    else if (result) job.resolve(result);
  }
}
