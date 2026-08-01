import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  Check,
  CircleAlert,
  Clapperboard,
  Clock3,
  Download,
  Film,
  Frame,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Square,
  TimerReset,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ProductionQueueSnapshot, QueueErrorView } from "../../shared/production-queue";
import type { OutputInspection } from "../../shared/system";
import type { Scene, TimelineSession } from "../../shared/timeline";
import type { WorkerConnectionStatus, WorkerStatuses } from "../../shared/worker-status";
import type {
  ImageGenerationProvider,
  VideoGenerationProvider,
} from "../../shared/scene-job";
import type { AppPage } from "../app-navigation";
import { HOME_MODE_LABELS } from "../home-workflow-state";
import type { HomeWorkflowMode } from "../integrated-workflow";
import { HomeDialog } from "./HomeDialog";
import { jobLabel, nearestScenes, productionControls, productionSummary } from "./homepage-model";
import {
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type TextProvider,
} from "../../shared/provider";

const STATUS_LABEL = {
  ready: "Sẵn sàng",
  running: "Đang chạy",
  paused: "Đang tạm dừng",
  stopped: "Đã dừng",
  error: "Có lỗi",
  completed: "Hoàn thành",
} as const;

function durationLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function dateLabel(value: string | null): string {
  if (!value) return "Chưa có dữ liệu";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Chưa có dữ liệu" : parsed.toLocaleString("vi-VN");
}

function workerSlotLabel(worker?: WorkerConnectionStatus): string {
  if (!worker?.connected) return "Mất kết nối";
  const connectedCount = worker.connectedCount || 1;
  if (connectedCount <= 1) return "Kết nối";
  const idleCount = worker.idleCount ?? Math.max(0, connectedCount - (worker.busyCount || 0));
  return `${idleCount}/${connectedCount} slot rảnh`;
}

function sceneStatus(scene: Scene, queue: ProductionQueueSnapshot | null): { image: string; video: string; frame: string } {
  const queued = queue?.scenes.find((item) => item.sceneId === scene.id);
  return {
    image: scene.chainRole === "continue" ? "Không cần" : queued?.imageAssetPath || scene.imageResultPath ? "Xong" : scene.imageStatus === "error" ? "Lỗi" : "Chờ",
    video: queued?.videoAssetPath || scene.videoResultPath ? "Xong" : scene.videoStatus === "error" ? "Lỗi" : "Chờ",
    frame: scene.chainRole === "continue" ? queued?.startFrameAssetPath ? "Sẵn sàng" : "Chờ frame" : "Độc lập",
  };
}

export function ProductionHome({
  session,
  mode,
  queue,
  output,
  workers,
  textProvider,
  onNavigate,
  onOpenScene,
  onStart,
  onPause,
  onResume,
  onStop,
  onRetry,
  onBuildVideo,
  onCheckConnections,
}: {
  session: TimelineSession;
  mode: HomeWorkflowMode;
  queue: ProductionQueueSnapshot | null;
  output: OutputInspection | null;
  workers: WorkerStatuses;
  textProvider: TextProvider;
  onNavigate: (page: AppPage) => void;
  onOpenScene: (sceneId: string) => void;
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: (sceneIds?: string[]) => Promise<void>;
  onBuildVideo: () => void;
  onCheckConnections: () => Promise<void>;
}) {
  const [stopOpen, setStopOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [checkingWorkers, setCheckingWorkers] = useState(false);
  const [thumbnail, setThumbnail] = useState("");
  const summary = useMemo(() => productionSummary(session, queue), [queue, session]);
  const activeScene = session.scenes.find((scene) => scene.id === queue?.activeSceneId) || null;
  const visibleScenes = useMemo(() => nearestScenes(session, queue?.activeSceneId || "", 3), [queue?.activeSceneId, session]);
  const nextJob = queue?.jobs.find((job) => job.status === "queued" && job.id !== queue.activeJobId) || null;
  const activeQueueScene = queue?.scenes.find((scene) => scene.sceneId === queue.activeSceneId);
  const videoFiles = output?.groups.find((group) => group.id === "videos")?.count || 0;
  const imageProvider = queue?.imageProvider || "google-flow";
  const videoProvider = queue?.videoProvider || "google-flow";
  const imageWorkerRole = IMAGE_PROVIDER_WORKER_ROLE[imageProvider];
  const videoWorkerRole = VIDEO_PROVIDER_WORKER_ROLE[videoProvider];
  const imageWorkerConnected = workers[imageWorkerRole]?.connected === true;
  const videoWorkerConnected = workers[videoWorkerRole]?.connected === true;
  const outputTarget = session.workflowSource.sourceKind === "script"
    ? session.workflowSource.outputTarget || "video"
    : "video";
  const directScriptVideo = session.workflowSource.sourceKind === "script" &&
    outputTarget === "video" &&
    (session.workflowSource.videoSourceMode || "direct") === "direct";
  const controls = productionControls(
    summary,
    outputTarget === "images"
      ? imageWorkerConnected
      : directScriptVideo
        ? videoWorkerConnected
        : imageWorkerConnected && videoWorkerConnected,
    videoFiles,
    outputTarget,
  );
  const textWorkerRole = TEXT_PROVIDER_WORKER_ROLE[textProvider];
  const textProviderLabel = TEXT_PROVIDER_LABEL[textProvider];
  const capCutReady = controls.capCut;
  const canStart = controls.start;
  const errorSceneIds = [...new Set((queue?.errors || []).map((error) => error.sceneId))];
  const run = async (key: string, operation: () => Promise<void>) => {
    if (actionBusy) return;
    setActionBusy(key);
    try { await operation(); } finally { setActionBusy(""); }
  };

  useEffect(() => {
    let active = true;
    setThumbnail("");
    const path = activeScene?.imageResultPath || activeQueueScene?.imageAssetPath;
    if (!path) return () => { active = false; };
    void window.flowx?.media.readImageDataUrl(path).then((value) => { if (active) setThumbnail(value); }, () => undefined);
    return () => { active = false; };
  }, [activeQueueScene?.imageAssetPath, activeScene?.id, activeScene?.imageResultPath]);

  const stages = [
    { id: "voice", label: session.workflowSource.sourceKind === "script" ? "Kịch bản" : "Voice/SRT", icon: AudioLines, value: session.workflowSource.sourceKind === "script" ? "Đã phân tích" : session.workflowSource.srtFileName || session.workflowSource.audioFileName ? "Sẵn sàng" : "Nguồn có sẵn", done: true, page: session.workflowSource.sourceKind === "script" ? "timeline" as AppPage : "voice" as AppPage },
    { id: "timeline", label: "Timeline/Prompt", icon: WandSparkles, value: `${session.scenes.length}/${session.scenes.length}`, done: true, page: "timeline" as AppPage },
    { id: "images", label: "Ảnh", icon: ImageIcon, value: directScriptVideo ? "Không cần" : `${summary.completedImages}/${summary.requiredImages}`, done: directScriptVideo || summary.completedImages === summary.requiredImages, page: "queue" as AppPage },
    { id: "videos", label: "Video", icon: Film, value: summary.submittedVideos > summary.completedVideos ? `${summary.completedVideos}/${summary.totalScenes} tải · ${summary.submittedVideos} gửi` : `${summary.completedVideos}/${summary.totalScenes}`, done: summary.completedVideos === summary.totalScenes && summary.totalScenes > 0, page: "queue" as AppPage },
    { id: "frames", label: "Frame cuối", icon: Frame, value: summary.finalFramesRequired ? `${summary.finalFramesReady}/${summary.finalFramesRequired}` : "Không cần", done: summary.finalFramesReady === summary.finalFramesRequired, page: "queue" as AppPage },
    { id: "capcut", label: "Dựng CapCut", icon: Clapperboard, value: capCutReady ? "Sẵn sàng" : "Chưa đủ đầu ra", done: false, disabled: !capCutReady, page: "output" as AppPage },
  ];
  return (
    <div className="kc-home-production-v2">
      <header className={`kc-home-production-session is-${summary.status}`}>
        <span><Radio size={20} /></span><div><small>DASHBOARD SẢN XUẤT</small><h2>{session.name}</h2><p>{HOME_MODE_LABELS[mode]} · lưu {dateLabel(session.savedAt)}</p></div><div><b className={`kc-home-status is-${summary.status}`}>{STATUS_LABEL[summary.status]}</b><small><Check size={11} /> Dữ liệu lưu theo phiên</small></div>
      </header>

      <section className="kc-home-production-grid">
        <article className="kc-home-total-progress">
          <header><div><small>TỔNG TIẾN ĐỘ</small><h3>{outputTarget === "prompts" ? "Timeline và prompt" : outputTarget === "images" ? "Tiến độ storyboard ảnh" : "Tiến độ video scene"}</h3></div><Layers3 size={18} /></header>
          <div className="kc-home-progress-content"><div className="kc-home-progress-ring" style={{ "--home-progress": `${summary.progressPercent * 3.6}deg` } as CSSProperties}><span><strong>{summary.progressPercent}%</strong><small>tiến trình</small></span></div><div><strong>{outputTarget === "prompts" ? `${summary.totalScenes} scene prompt` : outputTarget === "images" ? `${summary.completedImages}/${summary.requiredImages} ảnh` : summary.submittedVideos > summary.completedVideos ? `${summary.completedVideos}/${summary.totalScenes} video · ${summary.submittedVideos} đã gửi` : `${summary.completedVideos}/${summary.totalScenes} video`}</strong><span>{outputTarget === "prompts" ? "Sẵn sàng kiểm tra và xuất prompt" : outputTarget === "video" && summary.submittedVideos > summary.completedVideos ? "Đã gửi Flow; cần tải file về app" : "Đã tạo hợp lệ"}</span><i><b style={{ width: `${summary.progressPercent}%` }} /></i></div></div>
          <dl><div><dt>Tổng scene</dt><dd>{summary.totalScenes}</dd></div><div><dt>Thời lượng</dt><dd>{durationLabel(summary.totalDurationSeconds)}</dd></div><div><dt>Đang chạy</dt><dd>{summary.runningJobs}</dd></div><div><dt>Đang chờ</dt><dd>{summary.pendingJobs}</dd></div><div className="is-error"><dt>Lỗi</dt><dd>{summary.errorJobs}</dd></div><div className="is-warning"><dt>Blocked</dt><dd>{summary.blockedScenes}</dd></div></dl>
        </article>

        <article className="kc-home-current-job">
          <header><div><small>CÔNG VIỆC HIỆN TẠI</small><h3>{jobLabel(summary.activeJob, queue?.activeMediaType || null)}</h3></div>{summary.activeJob && <LoaderCircle className="spin" size={17} />}</header>
          <div className="kc-home-current-job-body"><div className="kc-home-current-thumb">{thumbnail ? <img src={thumbnail} alt={`Scene ${activeScene?.order}`} /> : <Clapperboard size={29} />}</div><div>{activeScene ? <><strong>Scene {activeScene.order}</strong><span>{activeScene.timeStart} → {activeScene.timeEnd}</span><div><b>{activeScene.durationSeconds}s</b><b>{activeScene.chainRole}</b></div></> : <><strong>Không có scene đang chạy</strong><span>Queue đang ở trạng thái {STATUS_LABEL[summary.status].toLowerCase()}.</span></>}</div></div>
          <dl><div><dt>Loại job</dt><dd>{summary.activeJob?.jobType || "—"}</dd></div><div><dt>Số lần thử</dt><dd>{summary.activeJob ? `${summary.activeJob.attempts}/${summary.activeJob.maxAttempts}` : "—"}</dd></div><div><dt>Dependency</dt><dd>{summary.activeJob?.dependsOn || "Không có"}</dd></div><div><dt>Worker message</dt><dd>{activeQueueScene?.lastError || (summary.activeJob ? "Đang chờ cập nhật từ worker" : "—")}</dd></div></dl>
        </article>
      </section>

      <section className="kc-home-pipeline">
        <header><div><small>DÂY CHUYỀN WORKFLOW</small><h3>Voice/SRT đến dựng video hoàn chỉnh</h3></div></header>
        <div>{stages.map((stage, index) => { const Icon = stage.icon; return <div key={stage.id} className={`${stage.done ? "is-done" : ""} ${stage.disabled ? "is-disabled" : ""}`}><button type="button" disabled={stage.disabled} title={stage.disabled ? "Cần đủ 100% video hợp lệ và không còn dependency bị chặn" : `Mở ${stage.label}`} onClick={() => stage.id === "capcut" ? onBuildVideo() : onNavigate(stage.page)}><span>{stage.done ? <Check size={15} /> : <Icon size={15} />}</span><strong>{stage.label}</strong><small>{stage.value}</small></button>{index < stages.length - 1 && <i><ArrowRight size={14} /></i>}</div>; })}</div>
      </section>

      <section className="kc-home-production-lower">
        <article className="kc-home-compact-timeline">
          <header><div><small>TIMELINE RÚT GỌN</small><h3>Scene gần công việc hiện tại</h3></div><button type="button" onClick={() => onNavigate("timeline")}>Mở toàn bộ Timeline <ArrowRight size={13} /></button></header>
          <div>{visibleScenes.map((scene) => { const status = sceneStatus(scene, queue); return <button key={scene.id} type="button" className={`${scene.id === queue?.activeSceneId ? "is-current" : ""} is-${scene.chainRole} duration-${scene.durationSeconds}`} onClick={() => onOpenScene(scene.id)}><small>Scene {scene.order}</small><strong>{scene.durationSeconds}s</strong><span>{scene.chainRole}</span><dl><div><dt>Ảnh</dt><dd>{status.image}</dd></div><div><dt>Video</dt><dd>{status.video}</dd></div><div><dt>Frame</dt><dd>{status.frame}</dd></div></dl>{scene.id === queue?.activeSceneId && <i>ĐANG CHẠY</i>}</button>; })}</div>
        </article>

        <aside className="kc-home-production-side">
          <article className="kc-home-compact-queue"><header><span><ListChecks size={16} /></span><div><small>HÀNG ĐỢI</small><h3>{STATUS_LABEL[summary.status]}</h3></div></header><dl><div><dt>Công việc hiện tại</dt><dd>{summary.activeJob?.id || "Không có"}</dd></div><div><dt>Đang chờ</dt><dd>{summary.pendingJobs}</dd></div><div><dt>Lỗi</dt><dd>{summary.errorJobs}</dd></div><div><dt>Scene tiếp theo</dt><dd>{nextJob?.sceneId || "—"}</dd></div></dl><button type="button" onClick={() => onNavigate("queue")}>Mở màn hình Sản xuất <ArrowRight size={13} /></button></article>
          <article className="kc-home-workers"><header><span><Radio size={16} /></span><div><small>KẾT NỐI WORKER</small><h3>Extension & AI Worker</h3></div><button type="button" disabled={checkingWorkers} title="Kiểm tra lại kết nối" onClick={() => { setCheckingWorkers(true); void onCheckConnections().finally(() => setCheckingWorkers(false)); }}><RefreshCw className={checkingWorkers ? "spin" : ""} size={14} /></button></header>{([{ role: textWorkerRole, label: `${textProviderLabel} Text` }, { role: imageWorkerRole, label: IMAGE_PROVIDER_LABEL[imageProvider] }, { role: videoWorkerRole, label: VIDEO_PROVIDER_LABEL[videoProvider] }]).map((entry) => { const worker = workers[entry.role]; return <div key={`${entry.role}:${entry.label}`}><span className={worker?.connected ? "is-connected" : "is-disconnected"} /><p><strong>{entry.label}</strong><small>{worker?.profileTag || "Chưa đăng ký profile"}</small></p><b>{workerSlotLabel(worker)}</b></div>; })}<footer><span>Heartbeat</span><b>{dateLabel(workers[videoWorkerRole]?.connectedAt || workers[imageWorkerRole]?.connectedAt || workers[textWorkerRole]?.connectedAt || null)}</b></footer></article>
        </aside>
      </section>

      <section className="kc-home-quick-controls"><div><small>ĐIỀU KHIỂN NHANH</small><strong>Điều khiển phiên hiện tại</strong></div><button className="button primary compact" type="button" disabled={!canStart || Boolean(actionBusy)} onClick={() => void run("start", onStart)}>{actionBusy === "start" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} Bắt đầu</button><button className="button secondary compact" type="button" disabled={!controls.pause || Boolean(actionBusy)} onClick={() => void run("pause", onPause)}><Pause size={14} /> Tạm dừng</button><button className="button secondary compact" type="button" disabled={!controls.resume || Boolean(actionBusy)} onClick={() => void run("resume", onResume)}><Play size={14} /> Tiếp tục</button><button className="button danger compact" type="button" disabled={!controls.stop || Boolean(actionBusy)} onClick={() => setStopOpen(true)}><Square size={14} /> Dừng phiên</button><button className="button secondary compact is-purple" type="button" disabled={!controls.retry || Boolean(actionBusy)} title="Xếp lại toàn bộ scene đang lỗi, kể cả lỗi Google Flow cần người dùng bấm chạy lại" onClick={() => void run("retry", () => onRetry(errorSceneIds))}><RotateCcw size={14} /> Xử lý lỗi và chạy lại</button><button className="button secondary compact" type="button" disabled={!activeScene} onClick={() => activeScene && onOpenScene(activeScene.id)}><Clapperboard size={14} /> Mở scene đang chạy</button><button className="button success compact" type="button" disabled={!capCutReady} title={capCutReady ? "Mở trình dựng CapCut" : `Cần ${summary.totalScenes} video hợp lệ; hiện có ${videoFiles}`} onClick={onBuildVideo}><Film size={14} /> Dựng video trong CapCut</button></section>

      {queue?.errors.length ? <section className="kc-home-attention-errors"><header><div><small>LỖI CẦN CHÚ Ý</small><h3>{queue.errors.length} lỗi trong phiên</h3></div><CircleAlert size={17} /></header><div>{queue.errors.slice(0, 5).map((error: QueueErrorView) => <article key={error.jobId}><span><AlertTriangle size={15} /></span><div><strong>Scene {error.orderIndex + 1} · {error.mediaType === "image" ? "Tạo ảnh" : "Tạo video"}</strong><p>{error.message}</p><small>{error.attempts}/{error.maxAttempts} lần · {dateLabel(error.updatedAt)}</small></div><button type="button" onClick={() => onOpenScene(error.sceneId)}>Mở lỗi</button><button type="button" disabled={Boolean(actionBusy)} onClick={() => void run(`retry:${error.sceneId}`, () => onRetry([error.sceneId]))}><RefreshCw size={13} /> Chạy lại</button></article>)}</div></section> : null}

      {stopOpen && <HomeDialog title="Dừng phiên sản xuất?" description="App sẽ yêu cầu các worker và hàng đợi dừng an toàn. Công việc đang thao tác có thể cần vài giây để kết thúc." confirmLabel="Dừng phiên" tone="danger" busy={actionBusy === "stop"} onCancel={() => setStopOpen(false)} onConfirm={() => void run("stop", async () => { await onStop(); setStopOpen(false); })} />}
    </div>
  );
}
