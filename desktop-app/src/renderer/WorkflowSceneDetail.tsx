import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  FileImage,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  ListRestart,
  Maximize2,
  RefreshCcw,
  Save,
  ShieldAlert,
  Trash2,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CharacterView } from "../shared/character";
import { extractVideoPromptSections, validateContinuityScene } from "../shared/continuity";
import type { SceneMediaType } from "../shared/scene-job";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { WORKFLOW_STATUS_LABELS, type WorkflowSceneView } from "./workflow-scene-view";

type DetailTab = "prompt" | "continuity" | "characters" | "dependency" | "retry" | "error" | "logs";

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "continuity", label: "Continuity" },
  { id: "characters", label: "Nhân vật" },
  { id: "dependency", label: "Phụ thuộc" },
  { id: "retry", label: "Lịch sử thử lại" },
  { id: "error", label: "Lỗi gần nhất" },
  { id: "logs", label: "Log chi tiết" },
];

export interface WorkflowSceneDetailActions {
  onPromptChange: (sceneId: string, mediaType: SceneMediaType, prompt: string) => void;
  onSave: () => void;
  onRun: (sceneId: string, mediaType: SceneMediaType, prompt: string) => void;
  onRegenerate: (sceneId: string, mediaType: SceneMediaType) => void;
  onApprove: (sceneId: string, mediaType: SceneMediaType) => void;
  onReject: (sceneId: string, mediaType: SceneMediaType, reason: string) => void;
  onRepairPolicy: (sceneId: string, mediaType: SceneMediaType) => void;
  onResumeFrom: (sceneId: string, mediaType: SceneMediaType) => void;
  onClear: (sceneId: string) => void;
  onOpenFolder: () => void;
  onSelect: (sceneId: string) => void;
}

function PromptEditor({
  title,
  value,
  onChange,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const riskWords = value.match(/\b(?:blood|weapon|kill|suicide|nude|celebrity|trẻ em|máu|vũ khí|tự sát)\b/gi) || [];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workflow-prompt-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><div><small>TRÌNH SOẠN THẢO PROMPT</small><h3>{title}</h3></div><button type="button" aria-label="Đóng trình sửa prompt" onClick={onClose}><X size={17} /></button></header>
        {riskWords.length > 0 && <div className="workflow-prompt-risk"><ShieldAlert size={15} /><span>Phát hiện từ khóa có thể cần kiểm tra chính sách: {[...new Set(riskWords)].join(", ")}</span></div>}
        <textarea value={value} onChange={(event) => onChange(event.target.value)} autoFocus />
        <footer><span>{value.length.toLocaleString("vi-VN")} ký tự</span><button className="button secondary" type="button" onClick={() => void navigator.clipboard.writeText(value)}><Copy size={14} /> Sao chép</button><button className="button primary" type="button" onClick={() => { onSave(); onClose(); }}><Save size={14} /> Lưu prompt</button></footer>
      </section>
    </div>
  );
}

export function WorkflowSceneDetail({
  item,
  allScenes,
  characters,
  directVideo = false,
  actions,
}: {
  item: WorkflowSceneView | null;
  allScenes: WorkflowSceneView[];
  characters: CharacterView[];
  directVideo?: boolean;
  actions: WorkflowSceneDetailActions;
}) {
  const [tab, setTab] = useState<DetailTab>("prompt");
  const [collapsed, setCollapsed] = useState(false);
  const [fullPrompt, setFullPrompt] = useState<SceneMediaType | null>(null);
  const [toast, setToast] = useState("");
  const characterMap = useMemo(() => new Map(characters.map((character) => [character.token.toUpperCase(), character])), [characters]);
  if (!item) return <aside className="workflow-scene-detail is-empty"><ClapperboardPlaceholder /><strong>Chọn một scene để xem chi tiết</strong></aside>;

  const scene = item.scene;
  const sceneIndex = allScenes.findIndex((entry) => entry.scene.id === scene.id);
  const previous = allScenes[sceneIndex - 1] || null;
  const next = allScenes[sceneIndex + 1] || null;
  const activeReviewMedia: SceneMediaType = (scene.videoResultPath || item.queueScene?.videoAssetPath) && item.videoStatus !== "approved" ? "video" : "image";
  const canApprove = activeReviewMedia === "video"
    ? item.videoStatus === "completed"
    : item.imageStatus === "completed";
  const canCreateVideo = item.dependencyReady && item.videoStatus !== "processing";
  const videoActionTitle = directVideo
    ? "Tạo video trực tiếp từ prompt, không dùng ảnh hoặc frame nối tiếp"
    : !canCreateVideo
    ? "Cần dependency hợp lệ trước khi tạo video"
    : item.queueScene?.imageAssetPath || scene.imageResultPath
      ? "Tạo video từ ảnh scene hoặc prompt trực tiếp"
      : "Tạo video trực tiếp từ prompt";
  const lastError = item.errors.at(-1) || null;
  const chain = allScenes.filter((entry) => scene.chainId && entry.scene.chainId === scene.chainId);
  const selectedCharacters = scene.usedCharacterTokens.map((token) => characterMap.get(token.toUpperCase()) || null);
  const continuitySections = extractVideoPromptSections(scene.videoPrompt);
  const continuationFramePath = scene.chainRole === "continue"
    ? item.queueScene?.startFrameAssetPath || scene.actualContinuityFrame?.path || previous?.scene.actualContinuityFrame?.path || ""
    : "";
  const startingFrameSource = scene.startingFrameSource || (
    directVideo ? "text-to-video" : scene.chainRole === "continue" ? "previous-scene-final-frame" : "generated-image"
  );
  const startingFramePath = scene.chainRole === "continue"
    ? continuationFramePath || "No linked frame path yet."
    : directVideo
      ? "Direct video mode does not require an opening image."
      : item.queueScene?.imageAssetPath || scene.imageResultPath || "No generated image path yet.";
  const continuityWarnings = validateContinuityScene(scene, previous?.scene || null, {
    previousFinalFramePath: continuationFramePath,
  });
  const blockingContinuityCount = continuityWarnings.filter((warning) => warning.severity === "blocking").length;
  const copy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setToast(message);
    window.setTimeout(() => setToast(""), 2_000);
  };
  const reject = () => {
    const reason = window.prompt("Nhập lý do từ chối asset hiện tại:", "Kết quả chưa đúng prompt hoặc chưa đảm bảo tính liên tục.");
    if (reason?.trim()) actions.onReject(scene.id, activeReviewMedia, reason.trim());
  };

  return (
    <aside className={`workflow-scene-detail ${collapsed ? "is-collapsed" : ""}`} aria-label={`Chi tiết Scene ${scene.order}`}>
      <header className="workflow-detail-header">
        <div><small>SCENE ĐANG CHỌN</small><h3>Scene {scene.order} <span>|</span> {scene.timeStart} → {scene.timeEnd}</h3><p><span className={`workflow-role is-${scene.chainRole}`}>{scene.chainRole}</span><code>{scene.id}</code><button type="button" title="Sao chép Scene ID" aria-label="Sao chép Scene ID" onClick={() => void copy(scene.id, "Đã sao chép Scene ID")}><Copy size={12} /></button></p></div>
        <button type="button" title={collapsed ? "Mở rộng panel" : "Thu gọn panel"} aria-label={collapsed ? "Mở rộng panel scene" : "Thu gọn panel scene"} onClick={() => setCollapsed((value) => !value)}><ChevronDown size={17} /></button>
      </header>
      {!collapsed && <>
        <section className="workflow-detail-preview">
          <div className="workflow-preview-frame">{item.thumbnail ? <img src={item.thumbnail} alt={`Preview Scene ${scene.order}`} /> : <ImageIcon size={40} />}<span>16:9</span></div>
          <div className="workflow-detail-stats">
            <article><small>Thời lượng</small><strong>{scene.durationSeconds}s</strong></article>
            <article><small>Loại</small><strong>{scene.chainRole}</strong></article>
            <article className="is-wide"><small>Trạng thái tổng thể</small><WorkflowStatusBadge status={item.overallStatus} /></article>
            {!directVideo && <article><small>Ảnh</small><WorkflowStatusBadge status={item.imageStatus} compact /></article>}
            <article><small>Video</small><WorkflowStatusBadge status={item.videoStatus} compact /></article>
            {!directVideo && <article className="is-wide"><small>Frame nối tiếp</small><WorkflowStatusBadge status={item.frameStatus} compact /></article>}
          </div>
        </section>
        <section className="workflow-detail-facts">
          <article><UserRound size={15} /><div><small>Nhân vật xuất hiện</small><strong>{scene.usedCharacterTokens.length}</strong></div></article>
          <button type="button" disabled={!item.previousScene} onClick={() => item.previousScene && actions.onSelect(item.previousScene.id)}><Link2 size={15} /><div><small>Phụ thuộc scene trước</small><strong>{item.previousScene ? `Scene ${item.previousScene.order}` : "Không có"}</strong></div></button>
          <article><ListRestart size={15} /><div><small>Số lần thử lại</small><strong>{item.retryCount} lần</strong></div></article>
          <article className={item.latestError ? "has-error" : ""}><AlertTriangle size={15} /><div><small>Lỗi gần nhất</small><strong>{item.latestError || "Không có lỗi"}</strong></div></article>
        </section>
        <section className="workflow-scene-actions" aria-label="Hành động scene">
          <button type="button" onClick={() => setTab("prompt")}><Maximize2 size={14} /> Mở chi tiết</button>
          {!directVideo && <button type="button" disabled={scene.chainRole === "continue" || item.imageStatus === "processing"} title={scene.chainRole === "continue" ? "Scene continue dùng frame cuối scene trước và không tạo ảnh riêng" : "Tạo ảnh scene"} onClick={() => actions.onRun(scene.id, "image", scene.imagePrompt)}><FileImage size={14} /> Tạo ảnh</button>}
          <button className="is-primary" type="button" disabled={!canCreateVideo} title={videoActionTitle} onClick={() => actions.onRun(scene.id, "video", scene.videoPrompt)}><Film size={14} /> Tạo video</button>
          <details><summary><RefreshCcw size={14} /> {directVideo ? "Tạo lại video" : "Tạo lại ảnh/video"}</summary><div>{!directVideo && <button type="button" onClick={() => actions.onRegenerate(scene.id, "image")}>Tạo lại ảnh</button>}<button type="button" disabled={!item.dependencyReady} onClick={() => actions.onRegenerate(scene.id, "video")}>Tạo lại video</button>{!directVideo && <button type="button" onClick={() => { actions.onRegenerate(scene.id, "image"); }}>Tạo lại cả ảnh và video</button>}</div></details>
          <button className="is-approve" type="button" disabled={!canApprove} onClick={() => actions.onApprove(scene.id, activeReviewMedia)}><Check size={14} /> Chấp nhận</button>
          <button className="is-reject" type="button" disabled={!canApprove} onClick={reject}><XCircle size={14} /> Từ chối</button>
          <button className="is-policy" type="button" onClick={() => actions.onRepairPolicy(scene.id, directVideo ? "video" : lastError?.mediaType || "video")}><ShieldAlert size={14} /> Sửa prompt vi phạm</button>
          <button type="button" onClick={() => actions.onResumeFrom(scene.id, directVideo || scene.chainRole === "continue" ? "video" : "image")}><ListRestart size={14} /> Tiếp tục queue từ scene</button>
          <button type="button" onClick={() => void copy(`${scene.imagePrompt}\n\n${scene.videoPrompt}`, "Đã sao chép prompt")}><Clipboard size={14} /> Sao chép prompt</button>
          <button type="button" onClick={actions.onSave}><Save size={14} /> Lưu prompt</button>
          <button type="button" onClick={actions.onOpenFolder}><FolderOpen size={14} /> Mở thư mục kết quả</button>
          <button className="is-danger" type="button" onClick={() => actions.onClear(scene.id)}><Trash2 size={14} /> Xóa kết quả, giữ prompt</button>
          <button type="button" disabled title="TODO: Chưa có IPC trích frame cuối độc lập; queue hiện tự trích sau khi tạo video"><Film size={14} /> Trích xuất lại frame cuối</button>
          <button type="button" disabled={!previous} onClick={() => previous && actions.onSelect(previous.scene.id)}><ChevronLeft size={14} /> Scene trước</button>
          <button type="button" disabled={!next} onClick={() => next && actions.onSelect(next.scene.id)}>Scene sau <ChevronRight size={14} /></button>
        </section>
        <section className="workflow-detail-tabs">
          <nav role="tablist">{TABS.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "is-active" : ""} onClick={() => setTab(entry.id)}>{entry.label}{entry.id === "continuity" && blockingContinuityCount > 0 && <b>{blockingContinuityCount}</b>}{entry.id === "error" && item.errors.length > 0 && <b>{item.errors.length}</b>}</button>)}</nav>
          <div className="workflow-detail-tab-content">
            {tab === "continuity" && <div className="workflow-continuity-tab">
              <div className="workflow-continuity-grid">
                <article><small>STARTING FRAME SOURCE</small><strong>{startingFrameSource}</strong><span>{startingFramePath}</span></article>
                <article><small>STARTING STATE</small><p>{scene.startingState || continuitySections.startingState || "Missing STARTING STATE section."}</p></article>
                <article><small>PRIMARY MOTION</small><p>{scene.primaryMotion || continuitySections.primaryMotion || "Missing PRIMARY MOTION section."}</p></article>
                <article><small>END FRAME</small><p>{scene.endFrame || continuitySections.endFrame || "Missing END FRAME section."}</p></article>
              </div>
              <div className="workflow-continuity-warnings">
                {continuityWarnings.length ? continuityWarnings.map((warning) => <article key={`${warning.severity}-${warning.code}-${warning.field || "scene"}`} className={`is-${warning.severity}`}><strong>{warning.severity}</strong><code>{warning.code}</code><span>{warning.message}</span></article>) : <p>No continuity warnings for this scene.</p>}
              </div>
            </div>}
            {tab === "prompt" && <div className="workflow-prompt-tab">
              {!directVideo && <article><header><strong>Prompt ảnh (rút gọn)</strong><button type="button" onClick={() => setFullPrompt("image")}><Code2 size={13} /> Xem đầy đủ</button></header><p>{scene.imagePrompt || "Scene continue không cần prompt ảnh."}</p></article>}
              <article><header><strong>Prompt video (rút gọn)</strong><button type="button" onClick={() => setFullPrompt("video")}><Code2 size={13} /> Xem đầy đủ</button></header><p>{scene.videoPrompt}</p></article>
              <article className="is-disabled"><header><strong>Negative prompt</strong><button type="button" disabled>Xem đầy đủ</button></header><p>Chưa có trường negative prompt trong model Scene hiện tại. TODO: cần backend/persistence trước khi bật.</p></article>
            </div>}
            {tab === "characters" && <div className="workflow-character-tab">{selectedCharacters.length ? selectedCharacters.map((character, index) => character ? <article key={character.token}><div>{character.refImageDataUrl ? <img src={character.refImageDataUrl} alt={character.name} /> : <UserRound size={22} />}</div><span><strong>{character.name}</strong><code>{character.token}</code><small>{character.clothing || "Chưa mô tả trang phục"}</small><small>{character.palette || "Chưa khóa bảng màu"}</small></span><WorkflowStatusBadge status={character.detailsLocked ? "approved" : "waiting"} label={character.detailsLocked ? "Đã khóa" : "Chưa khóa"} compact /></article> : <article key={scene.usedCharacterTokens[index]}><UserRound size={22} /><span><strong>{scene.usedCharacterTokens[index]}</strong><small>Không tìm thấy trong thư viện nhân vật</small></span></article>) : <p>Scene này không gán nhân vật.</p>}</div>}
            {tab === "dependency" && (directVideo ? <div className="workflow-dependency-tab"><article><strong>Video trực tiếp</strong><span>Scene này dùng prompt video trực tiếp, không yêu cầu ảnh hoặc frame nối tiếp.</span><WorkflowStatusBadge status={item.videoStatus} /></article></div> : <div className="workflow-dependency-tab"><div>{(chain.length ? chain : [item]).map((entry, index, values) => <span key={entry.scene.id}><button type="button" className={entry.scene.id === scene.id ? "is-active" : ""} onClick={() => actions.onSelect(entry.scene.id)}>Scene {entry.scene.order}</button>{index < values.length - 1 && <ChevronRight size={14} />}</span>)}</div><article><strong>Frame cuối scene trước</strong><span>{item.queueScene?.startFrameAssetPath || "Chưa có frame dependency"}</span><WorkflowStatusBadge status={item.frameStatus} /></article></div>)}
            {tab === "retry" && <div className="workflow-history-tab">{item.jobs.length ? item.jobs.map((job) => <article key={job.id}><code>{job.jobType}</code><span>Lần {job.attempts}/{job.maxAttempts}</span><WorkflowStatusBadge status={job.status === "running" ? "processing" : job.status === "failed" ? "error" : job.status === "succeeded" ? "completed" : "waiting"} compact /><small>Job ID: {job.id}</small></article>) : <p>Scene chưa có lịch sử công việc.</p>}</div>}
            {tab === "error" && <div className="workflow-error-tab">{lastError ? <article><AlertTriangle size={18} /><div><code>{lastError.category}</code><strong>{lastError.message}</strong><span>Công đoạn: {directVideo ? "video" : lastError.mediaType} · {new Date(lastError.updatedAt).toLocaleString("vi-VN")}</span><p>{directVideo || lastError.mediaType === "video" ? scene.videoPrompt : scene.imagePrompt}</p><footer><button type="button" onClick={() => actions.onRepairPolicy(scene.id, directVideo ? "video" : lastError.mediaType)}>Sửa prompt</button><button type="button" onClick={() => actions.onResumeFrom(scene.id, directVideo ? "video" : lastError.mediaType)}>Thử lại</button></footer></div></article> : <p>Không có lỗi gần nhất.</p>}</div>}
            {tab === "logs" && <div className="workflow-logs-tab"><header><span>Log được tổng hợp từ queue hiện tại</span><button type="button" onClick={() => void copy(item.jobs.map((job) => `[${job.status}] ${job.jobType} ${job.id}`).join("\n"), "Đã sao chép log")}><Copy size={13} /> Sao chép</button><button type="button" disabled title="TODO: Chưa có IPC xuất file log riêng theo scene">Tải log</button></header><pre>{item.jobs.map((job) => `[—] ${job.status.toUpperCase()} ${job.jobType} · lần ${job.attempts}/${job.maxAttempts}`).join("\n") || "[—] INFO Chưa có job cho scene này."}{item.errors.map((entry) => `\n[${entry.updatedAt}] ERROR ${entry.category}: ${entry.message}`).join("")}</pre></div>}
          </div>
        </section>
      </>}
      {toast && <div className="workflow-inline-toast" role="status">{toast}</div>}
      {fullPrompt && <PromptEditor title={`Prompt ${fullPrompt === "image" ? "ảnh" : "video"} · Scene ${scene.order}`} value={fullPrompt === "image" ? scene.imagePrompt : scene.videoPrompt} onChange={(value) => actions.onPromptChange(scene.id, fullPrompt, value)} onSave={actions.onSave} onClose={() => setFullPrompt(null)} />}
    </aside>
  );
}

function ClapperboardPlaceholder() {
  return <div className="workflow-detail-placeholder"><Film size={34} /></div>;
}
