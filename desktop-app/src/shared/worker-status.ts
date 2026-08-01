import type { CharactersBridge } from "./character";
import type { TimelineBridge } from "./timeline";
import type { SceneJobsBridge } from "./scene-job";
import type { MediaBridge } from "./media";
import type { VisualStylesBridge } from "./visual-style";
import type { ProductionQueueBridge } from "./production-queue";
import type { VoiceBridge } from "./voice";
import type { SystemBridge } from "./system";
import type { CapCutBridge } from "./capcut";
import type { EditBridge } from "./edit";
import type { ProviderSettingsBridge } from "./provider";

export const CORE_WORKER_ROLES = ["chat-worker", "flow-worker"] as const;
export const PROVIDER_WORKER_ROLES = ["claude-worker", "gemini-worker", "grok-worker", "capcut-worker"] as const;
export const WORKER_ROLES = [...CORE_WORKER_ROLES, ...PROVIDER_WORKER_ROLES] as const;

export const WORKER_ACTIONS = [
  "GENERATE_TIMELINE",
  "REWRITE_POLICY_PROMPT",
  "TRANSCRIBE_AUDIO",
  "REWRITE_SCRIPT",
  "GENERATE_IMAGE",
  "GENERATE_CHATGPT_IMAGE",
  "GENERATE_VIDEO",
  "GENERATE_PROVIDER_IMAGE",
  "GENERATE_PROVIDER_VIDEO",
] as const;

export type CoreWorkerRole = (typeof CORE_WORKER_ROLES)[number];
export type ProviderWorkerRole = (typeof PROVIDER_WORKER_ROLES)[number];
export type WorkerRole = (typeof WORKER_ROLES)[number];
export type WorkerAction = (typeof WORKER_ACTIONS)[number];
export type WorkerProvider = "chatgpt" | "google-flow" | "claude" | "gemini" | "grok" | "capcut";

export const WORKER_PROVIDER_BY_ROLE: Record<WorkerRole, WorkerProvider> = {
  "chat-worker": "chatgpt",
  "flow-worker": "google-flow",
  "claude-worker": "claude",
  "gemini-worker": "gemini",
  "grok-worker": "grok",
  "capcut-worker": "capcut",
};

export const WORKER_CAPABILITIES_BY_ROLE: Record<WorkerRole, readonly WorkerAction[]> = {
  "chat-worker": ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT", "GENERATE_CHATGPT_IMAGE"],
  "flow-worker": ["GENERATE_IMAGE", "GENERATE_VIDEO"],
  "claude-worker": ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT"],
  "gemini-worker": [
    "GENERATE_TIMELINE",
    "REWRITE_POLICY_PROMPT",
    "GENERATE_PROVIDER_IMAGE",
    "GENERATE_PROVIDER_VIDEO",
  ],
  "grok-worker": [
    "GENERATE_TIMELINE",
    "REWRITE_POLICY_PROMPT",
    "GENERATE_PROVIDER_IMAGE",
    "GENERATE_PROVIDER_VIDEO",
  ],
  "capcut-worker": ["GENERATE_PROVIDER_VIDEO"],
};

export interface WorkerConnectionStatus {
  role: WorkerRole;
  connected: boolean;
  profileTag: string | null;
  connectedAt: string | null;
  provider?: WorkerProvider;
  capabilities?: WorkerAction[];
  workerVersion?: string | null;
  connectedCount?: number;
  busyCount?: number;
  idleCount?: number;
}

export type WorkerStatuses =
  Record<CoreWorkerRole, WorkerConnectionStatus> &
  Partial<Record<ProviderWorkerRole, WorkerConnectionStatus>>;

export function normalizeWorkerCapabilities(value: unknown, role: WorkerRole): WorkerAction[] {
  const defaults = WORKER_CAPABILITIES_BY_ROLE[role];
  if (!Array.isArray(value)) return [...defaults];
  const allowed = new Set<WorkerAction>(defaults);
  return [...new Set(value.filter(
    (entry): entry is WorkerAction =>
      typeof entry === "string" && allowed.has(entry as WorkerAction),
  ))];
}

export function createDisconnectedWorkerStatus(role: WorkerRole): WorkerConnectionStatus {
  return {
    role,
    connected: false,
    profileTag: null,
    connectedAt: null,
    provider: WORKER_PROVIDER_BY_ROLE[role],
    capabilities: [...WORKER_CAPABILITIES_BY_ROLE[role]],
    workerVersion: null,
    connectedCount: 0,
    busyCount: 0,
    idleCount: 0,
  };
}

export interface KCAutoToolBridge {
  platform: string;
  characters: CharactersBridge;
  timeline: TimelineBridge;
  sceneJobs: SceneJobsBridge;
  media: MediaBridge;
  visualStyles: VisualStylesBridge;
  productionQueue: ProductionQueueBridge;
  voice: VoiceBridge;
  system: SystemBridge;
  capcut: CapCutBridge;
  edit: EditBridge;
  providerSettings: ProviderSettingsBridge;
  workers: {
    getStatuses: () => Promise<WorkerStatuses>;
    onStatusChange: (
      callback: (statuses: WorkerStatuses) => void,
    ) => () => void;
  };
}

export const WORKER_STATUS_CHANNEL = "workers:status";
export const WORKER_STATUS_GET_CHANNEL = "workers:get-statuses";

export function createDisconnectedStatuses(): WorkerStatuses {
  return {
    "chat-worker": createDisconnectedWorkerStatus("chat-worker"),
    "flow-worker": createDisconnectedWorkerStatus("flow-worker"),
  };
}
