import {
  AlertTriangle,
  Check,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  Filter,
  Image as ImageIcon,
  MoreHorizontal,
  RefreshCcw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { SceneMediaType } from "../shared/scene-job";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { WORKFLOW_STATUS_LABELS, type WorkflowAssetStatus, type WorkflowSceneView } from "./workflow-scene-view";

type SceneFilter = "4" | "6" | "8" | "single" | "start" | "continue" | WorkflowAssetStatus;

const FILTER_GROUPS: Array<{ label: string; options: Array<{ value: SceneFilter; label: string }> }> = [
  { label: "Thời lượng", options: [{ value: "4", label: "4s" }, { value: "6", label: "6s" }, { value: "8", label: "8s" }] },
  { label: "Loại scene", options: [{ value: "single", label: "single" }, { value: "start", label: "start" }, { value: "continue", label: "continue" }] },
  { label: "Trạng thái", options: [
    { value: "idle", label: "Chờ" }, { value: "waiting", label: "Đang chờ" }, { value: "processing", label: "Đang xử lý" },
    { value: "completed", label: "Hoàn thành" }, { value: "approved", label: "Đã duyệt" }, { value: "rejected", label: "Bị từ chối" },
    { value: "error", label: "Có lỗi" }, { value: "missing", label: "Thiếu frame nối tiếp" },
  ] },
];

function sceneMatchesFilter(item: WorkflowSceneView, filters: Set<SceneFilter>): boolean {
  if (!filters.size) return true;
  const durationFilters = ["4", "6", "8"].filter((value) => filters.has(value as SceneFilter));
  const roleFilters = ["single", "start", "continue"].filter((value) => filters.has(value as SceneFilter));
  const statusFilters = Object.keys(WORKFLOW_STATUS_LABELS).filter((value) => filters.has(value as SceneFilter));
  return (!durationFilters.length || durationFilters.includes(String(item.scene.durationSeconds))) &&
    (!roleFilters.length || roleFilters.includes(item.scene.chainRole)) &&
    (!statusFilters.length || statusFilters.some((status) => [item.imageStatus, item.videoStatus, item.frameStatus, item.overallStatus].includes(status as WorkflowAssetStatus)));
}

const SceneListRow = memo(function SceneListRow({
  item,
  selected,
  onSelect,
  onRegenerate,
  onClear,
  directVideo = false,
}: {
  item: WorkflowSceneView;
  selected: boolean;
  onSelect: (sceneId: string) => void;
  onRegenerate: (sceneId: string, mediaType: SceneMediaType) => void;
  onClear: (sceneId: string) => void;
  directVideo?: boolean;
}) {
  const scene = item.scene;
  return (
    <article className={`workflow-scene-row is-${item.overallStatus} ${item.latestError ? "has-error" : ""} ${selected ? "is-selected" : ""}`} role="row" tabIndex={0} aria-selected={selected} onClick={() => onSelect(scene.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(scene.id); }}>
      <span className="workflow-scene-number">{scene.order}</span>
      <div className="workflow-scene-identity">
        <div className="workflow-scene-thumbnail">
          {item.thumbnail ? <img src={item.thumbnail} alt={`Thumbnail Scene ${scene.order}`} loading="lazy" /> : <ImageIcon size={22} />}
          {item.latestError && <AlertTriangle size={14} />}
        </div>
        <div>
          <strong>Scene {scene.order}</strong>
          <small>{scene.timeStart} → {scene.timeEnd}</small>
          {scene.usedCharacterTokens.length > 0 && <em>{scene.usedCharacterTokens.join(", ")}</em>}
          {scene.policyFlag && (
            <span className="workflow-policy-flag" title={`Cần kiểm tra chính sách: ${scene.policyFlag}`}>
              <AlertTriangle size={11} /> Kiểm tra chính sách
            </span>
          )}
          {scene.policyResolution?.status === "auto_rewritten" && (
            <span className="workflow-policy-resolved" title={`Đã tự động làm an toàn: ${scene.policyResolution.originalFlag}`}>
              <Check size={11} /> Đã tự sửa chính sách
            </span>
          )}
        </div>
      </div>
      <span className={`workflow-duration is-${scene.durationSeconds}`}>{scene.durationSeconds}s</span>
      <span className={`workflow-role is-${scene.chainRole}`}>{scene.chainRole}</span>
      <div className="workflow-scene-statuses">
        {!directVideo && <span><b>Ảnh</b><WorkflowStatusBadge status={item.imageStatus} compact /></span>}
        <span><b>Video</b><WorkflowStatusBadge status={item.videoStatus} compact /></span>
        {!directVideo && <span><b>Frame</b><WorkflowStatusBadge status={item.frameStatus} compact /></span>}
        {!directVideo && !item.dependencyReady && <small><AlertTriangle size={11} /> Chờ frame cuối Scene {item.previousScene?.order || "trước"}</small>}
      </div>
      <details className="workflow-scene-menu" onClick={(event) => event.stopPropagation()}>
        <summary aria-label={`Thao tác Scene ${scene.order}`}><MoreHorizontal size={16} /></summary>
        <div>
          {!directVideo && <button type="button" onClick={() => onRegenerate(scene.id, "image")}><RotateCcw size={13} /> Tạo lại ảnh</button>}
          <button type="button" onClick={() => onRegenerate(scene.id, "video")} disabled={!item.dependencyReady}><RotateCcw size={13} /> Tạo lại video</button>
          <button type="button" className="is-danger" onClick={() => onClear(scene.id)}><Trash2 size={13} /> Xóa kết quả</button>
        </div>
      </details>
    </article>
  );
});

export function WorkflowSceneList({
  scenes,
  selectedSceneId,
  directVideo = false,
  onSelect,
  onRegenerate,
  onClear,
  onRefresh,
}: {
  scenes: WorkflowSceneView[];
  selectedSceneId: string;
  directVideo?: boolean;
  onSelect: (sceneId: string) => void;
  onRegenerate: (sceneId: string, mediaType: SceneMediaType) => void;
  onClear: (sceneId: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Set<SceneFilter>>(new Set());
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("vi-VN");
    return scenes.filter((item) => {
      if (!sceneMatchesFilter(item, filters)) return false;
      if (!normalized) return true;
      const scene = item.scene;
      const haystack = [
        scene.id, scene.order, scene.timeStart, scene.timeEnd, scene.durationSeconds, scene.chainRole,
        scene.imageStatus, scene.videoStatus, WORKFLOW_STATUS_LABELS[item.overallStatus],
        scene.usedCharacterTokens.join(" "), scene.imagePrompt, scene.videoPrompt, scene.policyFlag, item.latestError,
      ].join(" ").toLocaleLowerCase("vi-VN");
      return haystack.includes(normalized);
    });
  }, [filters, query, scenes]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [query, filters, pageSize]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);

  const toggleFilter = (value: SceneFilter) => setFilters((current) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
  const pageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
    const first = Math.max(1, Math.min(page - 2, totalPages - 4));
    return first + index;
  });

  return (
    <section className="workflow-scene-list" aria-label="Danh sách scene">
      <header className="workflow-scene-list-toolbar">
        <label><Search size={15} /><input value={query} placeholder="Tìm kiếm scene..." aria-label="Tìm kiếm scene" onChange={(event) => setQuery(event.target.value)} /></label>
        <details className="workflow-filter-menu">
          <summary><Filter size={14} /> Bộ lọc {filters.size > 0 && <b>{filters.size}</b>}</summary>
          <div>
            {FILTER_GROUPS.map((group) => <fieldset key={group.label}><legend>{group.label}</legend>{group.options.map((option) => <label key={option.value}><input type="checkbox" checked={filters.has(option.value)} onChange={() => toggleFilter(option.value)} /> {option.label}</label>)}</fieldset>)}
            <button type="button" disabled={!filters.size} onClick={() => setFilters(new Set())}>Xóa bộ lọc</button>
          </div>
        </details>
        <span>Hiển thị {filtered.length} / {scenes.length} scene</span>
        <button className="icon-button" type="button" title="Làm mới danh sách" aria-label="Làm mới danh sách scene" onClick={onRefresh}><RefreshCcw size={15} /></button>
      </header>
      <div className="workflow-scene-table-head" role="row"><span>#</span><span>SCENE & TIMELINE</span><span>THỜI LƯỢNG</span><span>LOẠI</span><span>{directVideo ? "TRẠNG THÁI VIDEO" : "TRẠNG THÁI (ẢNH / VIDEO / FRAME NỐI TIẾP)"}</span><span /></div>
      <div className="workflow-scene-list-scroll" role="table">
        {visible.length ? visible.map((item) => <SceneListRow key={item.scene.id} item={item} selected={item.scene.id === selectedSceneId} directVideo={directVideo} onSelect={onSelect} onRegenerate={onRegenerate} onClear={onClear} />) : <div className="workflow-scene-empty"><Search size={24} /><strong>Không tìm thấy scene phù hợp</strong><span>Thử thay đổi từ khóa hoặc bộ lọc.</span></div>}
      </div>
      <footer className="workflow-scene-pagination">
        <label>Scene mỗi trang <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
        <span>{filtered.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} / ${filtered.length}` : "0 scene"}</span>
        <nav aria-label="Phân trang scene">
          <button type="button" aria-label="Trang đầu" disabled={page === 1} onClick={() => setPage(1)}><ChevronsLeft size={14} /></button>
          <button type="button" aria-label="Trang trước" disabled={page === 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} /></button>
          {pageNumbers.map((number) => <button type="button" className={number === page ? "is-active" : ""} key={number} onClick={() => setPage(number)}>{number}</button>)}
          <button type="button" aria-label="Trang sau" disabled={page === totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={14} /></button>
          <button type="button" aria-label="Trang cuối" disabled={page === totalPages} onClick={() => setPage(totalPages)}><ChevronsRight size={14} /></button>
        </nav>
      </footer>
    </section>
  );
}
