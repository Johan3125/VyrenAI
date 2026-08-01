import {
  Bot,
  ExternalLink,
  Pause,
  Play,
  RadioTower,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { TimelineSession } from "../shared/timeline";
import type { WorkerConnectionStatus, WorkerStatuses } from "../shared/worker-status";
import type { AppPage } from "./app-navigation";
import {
  DEFAULT_PROVIDER_SETTINGS,
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_URL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_URL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type ProviderSettings,
} from "../shared/provider";

function useProviderSettings(): ProviderSettings {
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.flowx?.providerSettings.get().then((next) => {
        if (active) setSettings(next);
      });
    };
    refresh();
    window.addEventListener("vyren-provider-settings-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("vyren-provider-settings-changed", refresh);
    };
  }, []);

  return settings;
}

function readinessLabel(connected: boolean): string {
  return connected ? "Đã kết nối" : "Chưa kết nối";
}

function workerCapacityLabel(worker?: WorkerConnectionStatus): string {
  if (!worker?.connected) return readinessLabel(false);
  const connectedCount = worker.connectedCount || 1;
  if (connectedCount <= 1) return readinessLabel(true);
  const idleCount = worker.idleCount ?? Math.max(0, connectedCount - (worker.busyCount || 0));
  return `${idleCount}/${connectedCount} slot rảnh`;
}

export function ChatGPTWorkerPanel({
  session,
  workers,
  queue,
  onNavigate,
}: {
  session: TimelineSession | null;
  workers: WorkerStatuses;
  queue: ProductionQueueSnapshot | null;
  onNavigate: (page: AppPage) => void;
}) {
  const providerSettings = useProviderSettings();
  const workerRole = TEXT_PROVIDER_WORKER_ROLE[providerSettings.textProvider];
  const worker = workers[workerRole];
  const connected = worker?.connected === true;
  const scenes = session?.scenes || [];
  const visualBibleReady = Boolean(session && Object.values(session.visualBible).every(Boolean));
  const promptCount = scenes.filter((scene) => scene.imagePrompt && scene.videoPrompt).length;
  const textProviderLabel = TEXT_PROVIDER_LABEL[providerSettings.textProvider];

  return (
    <section className="kc-worker-panel">
      <header>
        <div className="kc-worker-title">
          <Bot size={18} />
          <div><span>AI NỘI DUNG</span><h3>{textProviderLabel}</h3></div>
        </div>
        <b className={connected ? "is-online" : "is-offline"}>
          <span />{readinessLabel(connected)}
        </b>
      </header>

      <div className="kc-worker-task-list">
        <div>
          <strong>Phiên hiện tại</strong>
          <small>{session ? `${scenes.length} scene` : "Chưa chọn phiên"}</small>
        </div>
        <div>
          <strong>Visual Bible</strong>
          <small>{visualBibleReady ? "Đã sẵn sàng" : "Chưa hoàn tất"}</small>
        </div>
        <div>
          <strong>Prompt hoàn chỉnh</strong>
          <small>{promptCount}/{scenes.length || 0} scene</small>
        </div>
        {queue?.errors.length ? (
          <div className="is-error">
            <strong>Lỗi cần xử lý</strong>
            <small>{queue.errors.length} lỗi trong hàng đợi</small>
          </div>
        ) : null}
      </div>

      <footer>
        <button type="button" onClick={() => onNavigate("settings")}><Settings size={13} /> Kết nối</button>
        <button type="button" onClick={() => onNavigate("timeline")}><Play size={13} /> Mở kịch bản cảnh</button>
      </footer>
    </section>
  );
}

export function GoogleFlowWorkerPanel({
  session,
  workers,
  queue,
  onNavigate,
}: {
  session: TimelineSession | null;
  workers: WorkerStatuses;
  queue: ProductionQueueSnapshot | null;
  onNavigate: (page: AppPage) => void;
}) {
  const providerSettings = useProviderSettings();
  const imageProvider = queue?.imageProvider || providerSettings.imageProvider;
  const videoProvider = queue?.videoProvider || providerSettings.videoProvider;
  const imageWorkerRole = IMAGE_PROVIDER_WORKER_ROLE[imageProvider];
  const videoWorkerRole = VIDEO_PROVIDER_WORKER_ROLE[videoProvider];
  const imageConnected = workers[imageWorkerRole]?.connected === true;
  const videoConnected = workers[videoWorkerRole]?.connected === true;
  const imageProviderLabel = IMAGE_PROVIDER_LABEL[imageProvider];
  const videoProviderLabel = VIDEO_PROVIDER_LABEL[videoProvider];
  const providerLinks = [
    { label: imageProviderLabel, url: IMAGE_PROVIDER_URL[imageProvider] },
    { label: videoProviderLabel, url: VIDEO_PROVIDER_URL[videoProvider] },
  ].filter((entry, index, entries) =>
    entries.findIndex((candidate) => candidate.url === entry.url) === index
  );
  const queueLabel = queue?.state === "running"
    ? "Đang chạy"
    : queue?.state === "paused"
      ? "Đang tạm dừng"
      : queue?.queuedJobs
        ? `${queue.queuedJobs} công việc đang chờ`
        : "Chưa có công việc";
  const connected = imageConnected && videoConnected;
  const bridge = window.flowx?.productionQueue;

  return (
    <section className="kc-worker-panel is-flow">
      <header>
        <div className="kc-worker-title">
          <RadioTower size={18} />
          <div><span>TẠO MEDIA</span><h3>{imageProviderLabel} / {videoProviderLabel}</h3></div>
        </div>
        <b className={queue?.errors.length ? "is-error" : connected ? "is-online" : "is-offline"}>
          <span />{queue?.errors.length ? "Cần xử lý" : connected ? "Sẵn sàng" : "Thiếu kết nối"}
        </b>
      </header>

      <div className="kc-worker-task-list">
        <div>
          <strong>Tạo ảnh · {imageProviderLabel}</strong>
          <small>{workerCapacityLabel(workers[imageWorkerRole])}</small>
        </div>
        <div>
          <strong>Tạo video · {videoProviderLabel}</strong>
          <small>{workerCapacityLabel(workers[videoWorkerRole])}</small>
        </div>
        <div>
          <strong>Hàng đợi</strong>
          <small>{queueLabel}</small>
        </div>
        {!session ? <div className="is-error"><strong>Phiên làm việc</strong><small>Chưa chọn phiên</small></div> : null}
      </div>

      <footer className="kc-flow-actions">
        <button type="button" onClick={() => onNavigate("settings")}><Settings size={13} /> Kết nối</button>
        <button type="button" onClick={() => onNavigate("timeline")}><Play size={13} /> Mở kịch bản cảnh</button>
        {queue?.state === "running"
          ? <button type="button" onClick={() => bridge && queue?.projectId && void bridge.pauseQueue(queue.projectId)}><Pause size={13} /> Tạm dừng</button>
          : queue?.queuedJobs
            ? <button type="button" onClick={() => bridge && queue?.projectId && void bridge.resumeQueue(queue.projectId)}><Play size={13} /> Tiếp tục</button>
            : null}
        {providerLinks.map((entry) => (
          <button key={entry.url} type="button" onClick={() => window.open(entry.url, "_blank")}>
            <ExternalLink size={13} /> Mở {entry.label}
          </button>
        ))}
      </footer>
    </section>
  );
}
