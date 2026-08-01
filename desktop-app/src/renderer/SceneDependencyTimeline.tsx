import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Eye,
  Focus,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Minus,
  Plus,
  RefreshCcw,
  RotateCcw,
  Unlink,
  X,
  XCircle,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { SceneMediaType } from "../shared/scene-job";
import {
  buildSceneGraphModel,
  chainFilterOptions,
  SCENE_GRAPH_NODE_HEIGHT,
  SCENE_GRAPH_NODE_WIDTH,
} from "./scene-dependency-model";
import type {
  ChainFilterValue,
  DependencyStatus,
  PositionedDependency,
  PositionedSceneNode,
} from "./scene-dependency-types";
import { WORKFLOW_STATUS_LABELS, type WorkflowAssetStatus, type WorkflowSceneView } from "./workflow-scene-view";

const DEPENDENCY_LABELS: Record<DependencyStatus, string> = {
  ready: "Frame đã sẵn sàng",
  extracting: "Đang trích xuất frame…",
  waiting: "Đang chờ video scene trước",
  missing: "Thiếu frame nối tiếp",
  error: "Scene trước bị lỗi",
  order: "Thứ tự clip",
  none: "Không có dependency",
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.4;
const DEFAULT_ZOOM = 0.82;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function StatusIcon({ status, size = 11 }: { status: WorkflowAssetStatus; size?: number }) {
  if (status === "processing") return <LoaderCircle className="spin" size={size} />;
  if (status === "approved" || status === "completed") return <Check size={size} />;
  if (status === "error" || status === "rejected") return <XCircle size={size} />;
  if (status === "missing") return <AlertTriangle size={size} />;
  return <Clock3 size={size} />;
}

function DependencyIcon({ status, size = 13 }: { status: DependencyStatus; size?: number }) {
  if (status === "ready") return <Check size={size} />;
  if (status === "extracting") return <LoaderCircle className="spin" size={size} />;
  if (status === "missing") return <AlertTriangle size={size} />;
  if (status === "error") return <XCircle size={size} />;
  if (status === "order") return <Link2 size={size} />;
  if (status === "none") return <Unlink size={size} />;
  return <Clock3 size={size} />;
}

function graphNodeEqual(left: { node: PositionedSceneNode; retrying: boolean }, right: { node: PositionedSceneNode; retrying: boolean }) {
  const a = left.node.data;
  const b = right.node.data;
  return left.retrying === right.retrying && left.node.x === right.node.x && left.node.y === right.node.y &&
    a.sceneId === b.sceneId && a.selected === b.selected && a.state === b.state && a.blocked === b.blocked &&
    a.imageStatus === b.imageStatus && a.videoStatus === b.videoStatus && a.finalFrameStatus === b.finalFrameStatus &&
    a.thumbnailUrl === b.thumbnailUrl && a.renderProgress === b.renderProgress && a.errorMessage === b.errorMessage;
}

const SceneNode = memo(function SceneNode({
  node,
  retrying,
  onSelect,
  onRetry,
}: {
  node: PositionedSceneNode;
  retrying: boolean;
  onSelect: (sceneId: string) => void;
  onRetry: (sceneId: string, mediaType: SceneMediaType) => void;
}) {
  const data = node.data;
  const select = () => onSelect(data.sceneId);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  };
  return (
    <article
      className={`scene-graph-node is-${data.state} role-${data.chainRole} ${data.selected ? "is-selected" : ""}`}
      style={{ left: node.x, top: node.y, width: SCENE_GRAPH_NODE_WIDTH, height: SCENE_GRAPH_NODE_HEIGHT }}
      role="button"
      tabIndex={0}
      aria-label={`Scene ${data.sceneNumber}, ${data.chainRole}, ${data.startTime} đến ${data.endTime}, ${data.state}`}
      aria-pressed={data.selected}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      {!data.directVideo && data.chainRole === "continue" && <span className="scene-node-port is-input" title="Input frame từ scene trước" />}
      {!data.directVideo && data.chainRole !== "single" && <span className="scene-node-port is-output" title="Output frame cuối" />}
      <header>
        <strong>Scene {data.sceneNumber}</strong>
        <span className={`workflow-role is-${data.chainRole}`}>{data.chainRole}</span>
      </header>
      <div className="scene-node-time"><code>{data.startTime} → {data.endTime}</code><b className={`workflow-duration is-${data.duration}`}>{data.duration}s</b></div>
      <div className="scene-node-thumbnail">
        {data.thumbnailUrl ? <img src={data.thumbnailUrl} alt="" loading="lazy" /> : <ImageIcon size={25} />}
        {data.processing && <span><LoaderCircle className="spin" size={12} />{data.renderProgress === undefined ? "Đang xử lý" : `${data.renderProgress}%`}</span>}
      </div>
      <div className="scene-node-statuses">
        {!data.directVideo && <span title={`Ảnh: ${WORKFLOW_STATUS_LABELS[data.imageStatus]}`}><b>Ảnh</b><i className={`is-${data.imageStatus}`}><StatusIcon status={data.imageStatus} /></i></span>}
        <span title={`Video: ${WORKFLOW_STATUS_LABELS[data.videoStatus]}`}><b>Video</b><i className={`is-${data.videoStatus}`}><StatusIcon status={data.videoStatus} /></i></span>
        {!data.directVideo && <span title={`Frame cuối: ${WORKFLOW_STATUS_LABELS[data.finalFrameStatus]}`}><b>Frame</b><i className={`is-${data.finalFrameStatus}`}><StatusIcon status={data.finalFrameStatus} /></i></span>}
      </div>
      {(data.directVideo || data.chainRole === "single") && <small className="scene-node-note">{data.directVideo && data.chainRole !== "single" ? <Link2 size={10} /> : <Unlink size={10} />} {data.directVideo ? data.chainRole === "single" ? "Prompt -> video" : "Prompt order" : "Không có dependency"}</small>}
      {!data.directVideo && data.blocked && <small className="scene-node-note is-warning"><AlertTriangle size={10} /> Thiếu frame nối tiếp</small>}
      {data.state === "error" && (
        <button
          className="scene-node-retry"
          type="button"
          disabled={retrying}
          title={data.errorMessage || "Thử lại scene lỗi"}
          aria-label={`Thử lại Scene ${data.sceneNumber}`}
          onClick={(event) => { event.stopPropagation(); onRetry(data.sceneId, data.retryMediaType); }}
        >
          {retrying ? <LoaderCircle className="spin" size={12} /> : <RefreshCcw size={12} />}
        </button>
      )}
    </article>
  );
}, graphNodeEqual);

function curvePath(startX: number, startY: number, endX: number, endY: number) {
  const offset = Math.max(24, Math.abs(endX - startX) * 0.48);
  const bend = Math.abs(endY - startY) < 8 ? -22 : 0;
  return `M ${startX} ${startY} C ${startX + offset} ${startY + bend}, ${endX - offset} ${endY + bend}, ${endX} ${endY}`;
}

function dependencyEqual(left: { dependency: PositionedDependency; selected: boolean }, right: { dependency: PositionedDependency; selected: boolean }) {
  return left.selected === right.selected && left.dependency.data.status === right.dependency.data.status &&
    left.dependency.data.finalFramePath === right.dependency.data.finalFramePath &&
    left.dependency.source.x === right.dependency.source.x && left.dependency.source.y === right.dependency.source.y &&
    left.dependency.target.x === right.dependency.target.x && left.dependency.target.y === right.dependency.target.y;
}

const DependencyEdge = memo(function DependencyEdge({
  dependency,
  selected,
  onSelect,
}: {
  dependency: PositionedDependency;
  selected: boolean;
  onSelect: (dependencyId: string) => void;
}) {
  const startX = dependency.source.x + SCENE_GRAPH_NODE_WIDTH;
  const startY = dependency.source.y + SCENE_GRAPH_NODE_HEIGHT / 2;
  const frameLeftX = dependency.frameX;
  const frameY = dependency.frameY + 29;
  const frameRightX = dependency.frameX + 68;
  const endX = dependency.target.x;
  const endY = dependency.target.y + SCENE_GRAPH_NODE_HEIGHT / 2;
  const first = curvePath(startX, startY, frameLeftX, frameY);
  const second = curvePath(frameRightX, frameY, endX, endY);
  const choose = () => onSelect(dependency.data.id);
  const keyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
  };
  return (
    <g
      className={`scene-dependency-edge is-${dependency.data.status} ${selected ? "is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Dependency từ Scene ${dependency.data.sourceSceneNumber} đến Scene ${dependency.data.targetSceneNumber}: ${DEPENDENCY_LABELS[dependency.data.status]}`}
      onClick={choose}
      onKeyDown={keyDown}
    >
      <path className="scene-edge-hit" d={first} />
      <path className="scene-edge-hit" d={second} />
      <path className="scene-edge-line" d={first} />
      <path className="scene-edge-line" d={second} markerEnd={`url(#scene-arrow-${dependency.data.status})`} />
    </g>
  );
}, dependencyEqual);

const FrameNode = memo(function FrameNode({
  dependency,
  onOpen,
}: {
  dependency: PositionedDependency;
  onOpen: (dependencyId: string) => void;
}) {
  const status = dependency.data.status;
  return (
    <button
      type="button"
      className={`scene-frame-node is-${status}`}
      style={{ left: dependency.frameX, top: dependency.frameY }}
      disabled={!dependency.data.finalFramePath}
      title={`${DEPENDENCY_LABELS[status]}${dependency.data.finalFramePath ? ` · ${dependency.data.finalFramePath}` : ""}`}
      aria-label={`Frame nối Scene ${dependency.data.sourceSceneNumber} và Scene ${dependency.data.targetSceneNumber}: ${DEPENDENCY_LABELS[status]}`}
      onClick={() => onOpen(dependency.data.id)}
    >
      <span className="frame-node-port is-input" />
      <DependencyIcon status={status} size={15} />
      <small>FRAME</small>
      <span className="frame-node-port is-output" />
    </button>
  );
});

function DependencyPopover({
  dependency,
  position,
  retrying,
  onClose,
  onSelectScene,
  onPreview,
  onRetry,
}: {
  dependency: PositionedDependency;
  position: { left: number; top: number };
  retrying: boolean;
  onClose: () => void;
  onSelectScene: (sceneId: string) => void;
  onPreview: () => void;
  onRetry: () => void;
}) {
  const data = dependency.data;
  const orderOnly = data.status === "order";
  return (
    <aside className="scene-dependency-popover" style={position} role="dialog" aria-label="Thông tin dependency">
      <header><span className={`is-${data.status}`}><DependencyIcon status={data.status} /></span><div><strong>Scene {data.sourceSceneNumber} → Scene {data.targetSceneNumber}</strong><small>{DEPENDENCY_LABELS[data.status]}</small></div><button type="button" aria-label="Đóng thông tin dependency" onClick={onClose}><X size={14} /></button></header>
      {orderOnly ? (
        <dl>
          <div><dt>Liên kết</dt><dd>Thứ tự prompt</dd></div>
          <div><dt>Scene nguồn</dt><dd>Scene {data.sourceSceneNumber}</dd></div>
          <div><dt>Scene đích</dt><dd>Scene {data.targetSceneNumber}</dd></div>
          <div><dt>Frame</dt><dd>Không dùng frame đầu vào</dd></div>
        </dl>
      ) : (
        <dl>
          <div><dt>Frame cuối</dt><dd title={data.finalFramePath}>{data.finalFramePath || "Chưa có"}</dd></div>
          <div><dt>Trạng thái file</dt><dd>{data.finalFramePath ? "Đã ghi nhận đường dẫn" : "Chưa có frame"}</dd></div>
          <div><dt>Thời điểm trích</dt><dd>{data.extractedAt || "Backend chưa cung cấp"}</dd></div>
          <div><dt>Kích thước</dt><dd>{data.fileSize === undefined ? "Backend chưa cung cấp" : `${Math.round(data.fileSize / 1024)} KB`}</dd></div>
          <div><dt>Độ phân giải</dt><dd>{data.width && data.height ? `${data.width} × ${data.height}` : "Backend chưa cung cấp"}</dd></div>
          <div><dt>Cập nhật</dt><dd>{data.updatedAt || "Backend chưa cung cấp"}</dd></div>
        </dl>
      )}
      {data.errorMessage && <p><AlertTriangle size={12} /> {data.errorMessage}</p>}
      <footer>
        {!orderOnly && <button type="button" disabled={!data.finalFramePath} onClick={onPreview}><Eye size={12} /> Xem frame</button>}
        {!orderOnly && <button type="button" disabled={retrying} onClick={onRetry}>{retrying ? <LoaderCircle className="spin" size={12} /> : <RefreshCcw size={12} />} Trích xuất lại</button>}
        <button type="button" onClick={() => onSelectScene(data.sourceSceneId)}>Scene nguồn</button>
        <button type="button" onClick={() => onSelectScene(data.targetSceneId)}>Scene đích</button>
      </footer>
    </aside>
  );
}

function FramePreviewPopover({ dependency, onClose, onOpenFolder, onRetry }: { dependency: PositionedDependency; onClose: () => void; onOpenFolder: () => void; onRetry: () => void }) {
  const [streamUrl, setStreamUrl] = useState("");
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    const path = dependency.data.finalFramePath;
    if (!path || !window.flowx?.media) return;
    void window.flowx.media.getStreamUrl(path).then(
      (url) => { if (active) setStreamUrl(url); },
      () => { if (active) setLoadError("Không thể mở preview frame từ đường dẫn hiện tại."); },
    );
    return () => { active = false; };
  }, [dependency.data.finalFramePath]);
  return (
    <aside className="scene-frame-preview" role="dialog" aria-label="Xem frame cuối">
      <header><div><strong>Frame cuối · Scene {dependency.data.sourceSceneNumber}</strong><small>Đang dùng cho Scene {dependency.data.targetSceneNumber}</small></div><button type="button" aria-label="Đóng preview frame" onClick={onClose}><X size={15} /></button></header>
      <div>{streamUrl ? <img src={streamUrl} alt={`Frame cuối Scene ${dependency.data.sourceSceneNumber}`} /> : loadError ? <span><AlertTriangle size={20} />{loadError}</span> : <span><LoaderCircle className="spin" size={20} />Đang mở frame…</span>}</div>
      <dl><div><dt>Độ phân giải</dt><dd>{dependency.data.width && dependency.data.height ? `${dependency.data.width} × ${dependency.data.height}` : "Chưa có metadata"}</dd></div><div><dt>Kích thước</dt><dd>{dependency.data.fileSize === undefined ? "Chưa có metadata" : `${Math.round(dependency.data.fileSize / 1024)} KB`}</dd></div><div><dt>Đường dẫn</dt><dd title={dependency.data.finalFramePath}>{dependency.data.finalFramePath}</dd></div></dl>
      <footer><button type="button" onClick={onOpenFolder}><ImageIcon size={12} /> Mở thư mục</button><button type="button" onClick={onRetry}><RefreshCcw size={12} /> Trích xuất lại</button></footer>
    </aside>
  );
}

export function SceneDependencyTimeline({
  scenes,
  snapshot,
  selectedSceneId,
  directVideo = false,
  onSelect,
  onRetry,
  onOpenFolder,
}: {
  scenes: WorkflowSceneView[];
  snapshot: ProductionQueueSnapshot | null;
  selectedSceneId: string;
  directVideo?: boolean;
  onSelect: (sceneId: string) => void;
  onRetry: (sceneId: string, mediaType: SceneMediaType) => void;
  onOpenFolder: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null);
  const lastCenteredSelectionRef = useRef("");
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pan, setPan] = useState({ x: 16, y: 8 });
  const [viewportSize, setViewportSize] = useState({ width: 900, height: 270 });
  const [autoFollow, setAutoFollow] = useState(true);
  const [followPaused, setFollowPaused] = useState(false);
  const [filter, setFilter] = useState<ChainFilterValue>("all");
  const [selectedDependencyId, setSelectedDependencyId] = useState("");
  const [previewDependencyId, setPreviewDependencyId] = useState("");
  const [retryingId, setRetryingId] = useState("");
  const [toast, setToast] = useState("");
  const options = useMemo(() => chainFilterOptions(scenes), [scenes]);
  const model = useMemo(() => buildSceneGraphModel(scenes, snapshot, selectedSceneId, filter, { directVideo }), [directVideo, filter, scenes, selectedSceneId, snapshot]);
  const selectedDependency = model.dependencies.find((entry) => entry.data.id === selectedDependencyId) || null;
  const previewDependency = model.dependencies.find((entry) => entry.data.id === previewDependencyId) || null;
  const activeSceneId = snapshot?.activeSceneId || "";

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const centerNode = useCallback((sceneId: string, force = false) => {
    const node = model.nodes.find((entry) => entry.data.sceneId === sceneId);
    if (!node) return;
    const left = node.x * zoom + pan.x;
    const right = (node.x + SCENE_GRAPH_NODE_WIDTH) * zoom + pan.x;
    const top = node.y * zoom + pan.y;
    const bottom = (node.y + SCENE_GRAPH_NODE_HEIGHT) * zoom + pan.y;
    const visible = left >= 18 && right <= viewportSize.width - 18 && top >= 18 && bottom <= viewportSize.height - 18;
    if (!force && visible) return;
    setPan({
      x: viewportSize.width / 2 - (node.x + SCENE_GRAPH_NODE_WIDTH / 2) * zoom,
      y: viewportSize.height / 2 - (node.y + SCENE_GRAPH_NODE_HEIGHT / 2) * zoom,
    });
  }, [model.nodes, pan.x, pan.y, viewportSize.height, viewportSize.width, zoom]);

  useEffect(() => {
    if (!autoFollow || followPaused || !activeSceneId) return;
    centerNode(activeSceneId);
  }, [activeSceneId, autoFollow, centerNode, followPaused]);

  useEffect(() => {
    if (!selectedSceneId || lastCenteredSelectionRef.current === selectedSceneId) return;
    lastCenteredSelectionRef.current = selectedSceneId;
    const frame = window.requestAnimationFrame(() => centerNode(selectedSceneId, true));
    return () => window.cancelAnimationFrame(frame);
  }, [centerNode, selectedSceneId]);

  useEffect(() => {
    setSelectedDependencyId("");
    setPreviewDependencyId("");
    setPan({ x: 16, y: 8 });
    lastCenteredSelectionRef.current = "";
  }, [filter]);

  const retry = useCallback((sceneId: string, mediaType: SceneMediaType) => {
    if (retryingId) return;
    setRetryingId(sceneId);
    setToast("Đã gửi yêu cầu thử lại vào hàng đợi.");
    onRetry(sceneId, mediaType);
    window.setTimeout(() => setRetryingId(""), 1_200);
    window.setTimeout(() => setToast(""), 2_300);
  }, [onRetry, retryingId]);

  const fitTimeline = useCallback(() => {
    const nextZoom = clamp(Math.min((viewportSize.width - 32) / model.width, (viewportSize.height - 32) / model.height), 0.05, 1);
    setZoom(nextZoom);
    setPan({ x: (viewportSize.width - model.width * nextZoom) / 2, y: (viewportSize.height - model.height * nextZoom) / 2 });
    setFollowPaused(false);
  }, [model.height, model.width, viewportSize.height, viewportSize.width]);

  const resetZoom = () => { setZoom(1); setPan({ x: 16, y: 8 }); setFollowPaused(false); };
  const changeZoom = (next: number) => {
    const value = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const centerX = viewportSize.width / 2;
    const centerY = viewportSize.height / 2;
    const graphX = (centerX - pan.x) / zoom;
    const graphY = (centerY - pan.y) / zoom;
    setZoom(value);
    setPan({ x: centerX - graphX * value, y: centerY - graphY * value });
    setFollowPaused(true);
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, article, .scene-dependency-edge, .scene-dependency-popover, .scene-frame-preview")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y, moved: false };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setPan({ x: drag.panX + dx, y: drag.panY + dy });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (dragRef.current.moved) setFollowPaused(true);
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const nextZoom = clamp(zoom * (event.deltaY > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
      const graphX = (mouseX - pan.x) / zoom;
      const graphY = (mouseY - pan.y) / zoom;
      setZoom(nextZoom);
      setPan({ x: mouseX - graphX * nextZoom, y: mouseY - graphY * nextZoom });
    } else {
      setPan((value) => ({ x: value.x - (event.shiftKey ? event.deltaY : event.deltaX || event.deltaY), y: value.y - (event.shiftKey ? 0 : event.deltaX ? event.deltaY : 0) }));
    }
    setFollowPaused(true);
  };

  const popoverPosition = selectedDependency ? {
    left: clamp(selectedDependency.frameX * zoom + pan.x + 44, 8, Math.max(8, viewportSize.width - 292)),
    top: clamp(selectedDependency.frameY * zoom + pan.y + 42, 8, Math.max(8, viewportSize.height - 224)),
  } : { left: 8, top: 8 };
  const compact = zoom < 0.62;

  return (
    <section className={`scene-dependency-timeline ${collapsed ? "is-collapsed" : ""}`} aria-label="Timeline chuỗi Scene">
      <header className="scene-graph-toolbar">
        <div className="scene-graph-title"><Link2 size={16} /><span><strong>Timeline chuỗi Scene</strong><small>Dependency dạng dây nối</small></span></div>
        <button type="button" role="switch" aria-checked={autoFollow} className={`scene-graph-follow-toggle ${autoFollow ? "is-on" : ""}`} onClick={() => { setAutoFollow((value) => !value); setFollowPaused(false); }}><i /><span>Tự theo dõi</span></button>
        {autoFollow && followPaused && <small className="scene-graph-follow-paused">Đã tạm ngắt do bạn di chuyển</small>}
        <button type="button" className="scene-graph-tool" title="Fit toàn bộ node" aria-label="Fit timeline" onClick={fitTimeline}><Maximize2 size={14} /><span>Fit timeline</span></button>
        <div className="scene-graph-zoom" aria-label="Điều khiển zoom"><button type="button" aria-label="Thu nhỏ timeline" onClick={() => changeZoom(zoom - 0.1)}><Minus size={13} /></button><button type="button" title="Đặt zoom về 100%" onClick={resetZoom}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="Phóng to timeline" onClick={() => changeZoom(zoom + 0.1)}><Plus size={13} /></button></div>
        <button type="button" className="scene-graph-tool" disabled={!activeSceneId} title="Theo dõi scene đang xử lý" onClick={() => { setAutoFollow(true); setFollowPaused(false); centerNode(activeSceneId, true); }}><LocateFixed size={14} /><span>Scene hiện tại</span></button>
        <label className="scene-chain-filter"><span className="sr-only">Lọc theo chain</span><select value={filter} onChange={(event) => setFilter(event.target.value as ChainFilterValue)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button type="button" className="scene-graph-collapse" aria-label={collapsed ? "Mở timeline chuỗi Scene" : "Thu gọn timeline chuỗi Scene"} title={collapsed ? "Mở timeline" : "Thu gọn timeline"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      </header>
      {!collapsed && (
        <div
          ref={viewportRef}
          className={`scene-graph-viewport ${dragRef.current ? "is-panning" : ""}`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          onWheel={wheel}
        >
          {model.nodes.length ? (
            <div className={`scene-graph-stage ${compact ? "is-compact" : ""}`} style={{ width: model.width, height: model.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
              <svg className="scene-graph-edges" width={model.width} height={model.height} aria-hidden="false">
                <defs>{(["ready", "extracting", "waiting", "missing", "error", "order"] as DependencyStatus[]).map((status) => <marker key={status} id={`scene-arrow-${status}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" className={`is-${status}`} /></marker>)}</defs>
                {model.dependencies.map((dependency) => <DependencyEdge key={dependency.data.id} dependency={dependency} selected={dependency.data.id === selectedDependencyId} onSelect={(id) => { setSelectedDependencyId(id); setPreviewDependencyId(""); }} />)}
              </svg>
              {model.dependencies.filter((dependency) => dependency.data.status !== "order").map((dependency) => <FrameNode key={`frame:${dependency.data.id}`} dependency={dependency} onOpen={(id) => { setPreviewDependencyId(id); setSelectedDependencyId(""); }} />)}
              {model.dependencies.map((dependency) => <span key={`label:${dependency.data.id}`} className={`scene-edge-label is-${dependency.data.status}`} style={{ left: dependency.frameX - 34, top: dependency.frameY + 64 }}><DependencyIcon status={dependency.data.status} size={10} />{DEPENDENCY_LABELS[dependency.data.status]}</span>)}
              {model.nodes.map((node) => <SceneNode key={node.data.sceneId} node={node} retrying={retryingId === node.data.sceneId} onSelect={onSelect} onRetry={retry} />)}
            </div>
          ) : <div className="scene-graph-empty"><Focus size={26} /><strong>Không có scene phù hợp</strong><span>Chọn một chain khác hoặc làm mới trạng thái workflow.</span></div>}
          {selectedDependency && <DependencyPopover dependency={selectedDependency} position={popoverPosition} retrying={retryingId === selectedDependency.data.targetSceneId} onClose={() => setSelectedDependencyId("")} onSelectScene={(id) => { onSelect(id); setSelectedDependencyId(""); }} onPreview={() => { setPreviewDependencyId(selectedDependency.data.id); setSelectedDependencyId(""); }} onRetry={() => retry(selectedDependency.data.targetSceneId, "video")} />}
          {previewDependency && <FramePreviewPopover dependency={previewDependency} onClose={() => setPreviewDependencyId("")} onOpenFolder={onOpenFolder} onRetry={() => retry(previewDependency.data.targetSceneId, "video")} />}
          <small className="scene-graph-hint"><RotateCcw size={10} /> Kéo vùng trống để di chuyển · Ctrl + cuộn để zoom</small>
          {toast && <div className="scene-graph-toast" role="status">{toast}</div>}
        </div>
      )}
    </section>
  );
}
