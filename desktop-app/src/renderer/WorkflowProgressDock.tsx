import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Clapperboard,
  GripVertical,
  Image as ImageIcon,
  ListTree,
  LoaderCircle,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { TimelineProgress, TimelineSession } from "../shared/timeline";
import type { AppPage } from "./app-navigation";
import { HomeDialog } from "./home/HomeDialog";

interface DockStep {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  active: boolean;
  error: boolean;
  page: AppPage;
  icon: typeof AudioLines;
}

interface DockPosition {
  x: number;
  y: number;
}

const TERMINAL_TIMELINE_STATES = new Set(["succeeded", "failed", "cancelled"]);
const POSITION_STORAGE_KEY = "vyren-ai.workflow-dock-position.v1";
const EXPANDED_STORAGE_KEY = "vyren-ai.workflow-dock-expanded.v1";

function initialPosition(): DockPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) || "null") as Partial<DockPosition> | null;
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) {
      return { x: Number(stored?.x), y: Number(stored?.y) };
    }
  } catch {
    // Ignore invalid UI preferences and use a visible default.
  }
  return { x: window.innerWidth > 900 ? 300 : 12, y: 82 };
}

export function WorkflowProgressDock({
  session,
  queue,
  timelineProgress,
  onNavigate,
  onBuildVideo,
  onPauseQueue,
  onResumeQueue,
  onStopSession,
}: {
  session: TimelineSession | null;
  queue: ProductionQueueSnapshot | null;
  timelineProgress: TimelineProgress | null;
  onNavigate: (page: AppPage) => void;
  onBuildVideo: () => void;
  onPauseQueue: () => Promise<void>;
  onResumeQueue: () => Promise<void>;
  onStopSession: () => Promise<void>;
}) {
  const dockRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [position, setPosition] = useState<DockPosition>(initialPosition);
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPANDED_STORAGE_KEY) === "true");
  const [actionBusy, setActionBusy] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const scenes = session?.scenes || [];
  const queueScenes = queue?.projectId === session?.id ? queue?.scenes || [] : [];
  const completedVideos = scenes.filter((scene) => {
    const queued = queueScenes.find((item) => item.sceneId === scene.id);
    return Boolean(queued?.videoAssetPath || scene.videoResultPath);
  }).length;
  const submittedVideos = scenes.filter((scene) => {
    const queued = queueScenes.find((item) => item.sceneId === scene.id);
    return queued?.status === "video_submitted" || scene.videoStatus === "submitted";
  }).length;
  const visibleVideoProgress = Math.max(completedVideos, submittedVideos);
  const requiredImages = scenes.filter((scene) => scene.chainRole !== "continue");
  const completedImages = requiredImages.filter((scene) => {
    const queued = queueScenes.find((item) => item.sceneId === scene.id);
    return Boolean(queued?.imageAssetPath || scene.imageResultPath);
  }).length;
  const inputReady = Boolean(
    session?.workflowSource.audioPath || session?.workflowSource.srtPath ||
    session?.workflowSource.srtText?.trim() || session?.workflowSource.narrationText?.trim(),
  );
  const promptsReady = scenes.length > 0 && scenes.every((scene) =>
    Boolean(scene.videoPrompt.trim()) && (scene.chainRole === "continue" || Boolean(scene.imagePrompt.trim())),
  );
  const imagesReady = requiredImages.length === 0 || completedImages === requiredImages.length;
  const videosReady = scenes.length > 0 && completedVideos === scenes.length;
  const timelineActive = Boolean(
    timelineProgress && !TERMINAL_TIMELINE_STATES.has(timelineProgress.status),
  );
  const queueActive = queue?.state === "running";
  const queuePaused = queue?.state === "paused";
  const canResume = queuePaused || (queue?.state === "stopped" && Boolean(queue.queuedJobs));
  const errors = queue?.errors.length || 0;
  const activeJob = queue?.jobs.find((job) => job.id === queue.activeJobId);

  const clampPosition = (candidate: DockPosition): DockPosition => {
    const width = dockRef.current?.offsetWidth || 360;
    const height = dockRef.current?.offsetHeight || 70;
    const currentScreen = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availLeft = currentScreen.availLeft || 0;
    const availTop = currentScreen.availTop || 0;
    const visibleLeft = Math.max(8, availLeft - window.screenX + 8);
    const visibleTop = Math.max(8, availTop - window.screenY + 8);
    const visibleRight = Math.max(
      visibleLeft,
      Math.min(
        window.innerWidth - width - 8,
        availLeft + currentScreen.availWidth - window.screenX - width - 8,
      ),
    );
    const visibleBottom = Math.max(
      visibleTop,
      Math.min(
        window.innerHeight - height - 34,
        availTop + currentScreen.availHeight - window.screenY - height - 8,
      ),
    );
    return {
      x: Math.max(visibleLeft, Math.min(candidate.x, visibleRight)),
      y: Math.max(visibleTop, Math.min(candidate.y, visibleBottom)),
    };
  };

  useEffect(() => {
    localStorage.setItem(EXPANDED_STORAGE_KEY, String(expanded));
    const frame = window.requestAnimationFrame(() => setPosition((current) => clampPosition(current)));
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  useEffect(() => {
    const resize = () => setPosition((current) => clampPosition(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampPosition({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setPosition((current) => {
      const next = clampPosition(current);
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const runAction = async (action: () => Promise<void>) => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await action();
    } finally {
      setActionBusy(false);
    }
  };

  const steps: DockStep[] = [
    { id: "input", label: "Voice & SRT", detail: inputReady ? "Đã sẵn sàng" : "Chưa có đầu vào", done: inputReady, active: false, error: false, page: "voice", icon: AudioLines },
    { id: "timeline", label: "Timeline", detail: timelineActive ? "Đang tách prompt" : scenes.length ? `${scenes.length} scene` : "Chưa tạo", done: promptsReady, active: timelineActive, error: timelineProgress?.status === "failed", page: "timeline", icon: ListTree },
    { id: "images", label: "Ảnh", detail: `${completedImages}/${requiredImages.length}`, done: imagesReady && scenes.length > 0, active: queueActive && queue?.activeMediaType === "image", error: queue?.errors.some((error) => error.mediaType === "image") || false, page: "queue", icon: ImageIcon },
    { id: "videos", label: "Video", detail: submittedVideos > completedVideos ? `${completedVideos}/${scenes.length} tải · ${submittedVideos} gửi` : `${completedVideos}/${scenes.length}`, done: videosReady, active: queueActive && (queue?.activeMediaType === "video" || activeJob?.jobType === "extract_last_frame"), error: queue?.errors.some((error) => error.mediaType === "video") || false, page: "queue", icon: Clapperboard },
  ];

  const progress = scenes.length
    ? Math.round(Number(inputReady) * 15 + Number(promptsReady) * 20 + (requiredImages.length ? completedImages / requiredImages.length : 1) * 25 + (visibleVideoProgress / scenes.length) * 40)
    : inputReady ? 15 : 0;
  const currentMessage = timelineActive
    ? timelineProgress?.message || "ChatGPT đang phân tích timeline và prompt"
    : queueActive
      ? `${queue.activeSceneId || "Scene"} · ${activeJob?.jobType === "extract_last_frame" ? "trích frame cuối" : queue.activeMediaType === "image" ? "đang tạo ảnh" : "đang tạo video"}`
      : queuePaused
        ? "Workflow đang tạm dừng — phiên vẫn được khóa"
          : errors
            ? `${errors} lỗi cần xử lý trước khi tiếp tục`
          : videosReady
            ? "Đã đủ 100% scene — sẵn sàng dựng vào CapCut"
            : submittedVideos > completedVideos
              ? `Đã gửi ${submittedVideos}/${scenes.length} prompt sang Flow; cần tải video về app`
            : scenes.length
              ? `Đã hoàn thành ${completedVideos}/${scenes.length} video scene`
              : "Chưa bắt đầu sản xuất phiên này";

  if (!timelineActive && !queueActive && !queuePaused) return null;

  return (
    <section
      ref={dockRef}
      className={`kc-workflow-dock ${expanded ? "is-expanded" : "is-collapsed"} ${timelineActive || queueActive ? "is-running" : ""} ${errors ? "has-error" : ""}`}
      style={{ left: position.x, top: position.y }}
      aria-label="Tiến trình phiên đang chạy"
    >
      <header className="kc-workflow-dock-header">
        <button className="kc-workflow-drag-handle" type="button" title="Giữ và kéo để di chuyển" aria-label="Di chuyển bảng tiến trình" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <GripVertical size={17} />
        </button>
        <button className="kc-workflow-dock-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span className="kc-workflow-dock-percent">{progress}%</span>
          <span className="kc-workflow-dock-copy"><strong>{session?.name || "Chưa có phiên"}</strong><small>{currentMessage}</small></span>
          {(timelineActive || queueActive) && <LoaderCircle className="spin" size={16} />}
          {errors > 0 && !timelineActive && !queueActive && <CircleAlert size={16} />}
          <ChevronDown className="kc-workflow-dock-chevron" size={17} />
        </button>
      </header>
      <div className="kc-workflow-dock-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      {expanded && (
        <div className="kc-workflow-dock-body">
          <div className="kc-workflow-dock-steps">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <button key={step.id} type="button" className={`${step.done ? "is-done" : ""} ${step.active ? "is-active" : ""} ${step.error ? "is-error" : ""}`} onClick={() => onNavigate(step.page)}>
                  <span>{step.done ? <Check size={13} /> : step.active ? <LoaderCircle className="spin" size={13} /> : <Icon size={13} />}</span>
                  <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                </button>
              );
            })}
          </div>
          <footer className="kc-workflow-dock-actions">
            <div>
              {queueActive && <button className="button secondary compact" type="button" disabled={actionBusy} onClick={() => void runAction(onPauseQueue)}><Pause size={14} /> Tạm dừng Flow</button>}
              {canResume && <button className="button secondary compact" type="button" disabled={actionBusy} onClick={() => void runAction(onResumeQueue)}><Play size={14} /> Tiếp tục</button>}
              {(timelineActive || queueActive || queuePaused || queue?.activeJobId) && <button className="button danger compact" type="button" disabled={actionBusy} onClick={() => setStopConfirmOpen(true)}><Square size={14} /> Dừng phiên</button>}
            </div>
            <button className={`kc-build-video-button ${videosReady ? "is-ready" : ""}`} type="button" disabled={!videosReady || actionBusy} onClick={onBuildVideo} title={videosReady ? "Kiểm tra và dựng toàn bộ scene vào project CapCut" : `Cần đủ video scene (${completedVideos}/${scenes.length})`}>
              <Clapperboard size={16} />
              <span><strong>Dựng video</strong><small>{videosReady ? "Đủ 100% scene" : `${completedVideos}/${scenes.length} scene`}</small></span>
            </button>
          </footer>
        </div>
      )}
      {stopConfirmOpen && <HomeDialog title="Dừng phiên sản xuất?" description="App sẽ yêu cầu các worker và hàng đợi dừng an toàn. Công việc đang thao tác có thể cần vài giây để kết thúc." confirmLabel="Dừng phiên" tone="danger" busy={actionBusy} onCancel={() => setStopConfirmOpen(false)} onConfirm={() => void runAction(async () => { await onStopSession(); setStopConfirmOpen(false); })} />}
    </section>
  );
}
