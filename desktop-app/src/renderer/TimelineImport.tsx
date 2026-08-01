import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clapperboard,
  FileText,
  FolderPlus,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  matchCharacterNames,
  parseCharacterTokens,
  recurringCharacterRoster,
  type CharacterView,
} from "../shared/character";
import {
  DEFAULT_IMAGE_GENERATION_PROVIDER,
  DEFAULT_VIDEO_GENERATION_PROVIDER,
  imageModelForProvider,
  projectOutputFolder,
  videoModelForProvider,
  type ImageGenerationProvider,
  type SceneMediaType,
  type SceneJobProgress,
  type VideoGenerationProvider,
} from "../shared/scene-job";
import {
  DEFAULT_TIMELINE_WORKFLOW_SOURCE,
  DEFAULT_VISUAL_BIBLE,
  isImportedVoiceAudioSource,
  MAX_TIMELINE_FILE_BYTES,
  normalizeStoredScenes,
  recalculateScenePlanning,
  SCENE_DURATION_OPTIONS,
  type PromptFileVideoMode,
  type Scene,
  type SceneChainRole,
  type SceneDurationSeconds,
  type TimelineProgress,
  type TimelineOutputTarget,
  type TimelinePacing,
  type TimelineSession,
  type TimelineSessionSummary,
  type TimelineStyleReference,
  type TimelineVideoSourceMode,
  type TimelineWorkflowSource,
  type VideoWorkflowMode,
  type VisualBible,
} from "../shared/timeline";
import {
  analyzePromptFileText,
  detectLocalPromptFilePath,
  promptFileScenesForMode,
  promptFileWorkflowSourceForMode,
  scenesMatchPromptFileImport,
  type PromptFileImportIssue,
  type PromptFileImportResult,
} from "../shared/prompt-file";
import { buildScriptTimingPlan } from "../shared/script-timing";
import { VOICE_PROVIDER_LABEL } from "../shared/voice";
import { ImageGenerationModal } from "./ImageGenerationModal";
import { VideoGenerationModal } from "./VideoGenerationModal";
import { VisualBiblePanel } from "./VisualBiblePanel";
import { WorkflowDashboard, type WorkflowDashboardActions } from "./WorkflowDashboard";
import type { GraphicStylePreset } from "../shared/visual-style";
import type { IntegratedWorkflowHandoff } from "./integrated-workflow";
import {
  DEFAULT_PROJECT_ID,
  type ProductionQueueSnapshot,
  type QueueErrorView,
} from "../shared/production-queue";
import {
  DEFAULT_PROVIDER_SETTINGS,
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type TextProvider,
} from "../shared/provider";
import type { WorkerStatuses } from "../shared/worker-status";

interface TimelineImportProps {
  workers: WorkerStatuses;
  integratedHandoff?: IntegratedWorkflowHandoff | null;
  onIntegratedHandoffConsumed?: () => void;
  onWorkflowReady?: () => void;
  onBuildVideo?: () => void;
  onBack?: () => void;
}

const TIMELINE_STORAGE_KEY = "flowx.timeline.scenes.v1";

const POLICY_REASON_OPTIONS = [
  {
    value: "auto",
    label: "Tự nhận diện từ Flow",
    description: "Ưu tiên nguyên văn thông báo vừa xuất hiện trên card render.",
  },
  {
    value: "violence",
    label: "Bạo lực hoặc gây hại",
    description: "Thương tích, máu me, đe dọa, hành hung hoặc kích động bạo lực.",
  },
  {
    value: "sexual",
    label: "Tình dục hoặc khỏa thân",
    description: "Nội dung tình dục rõ ràng, gợi dục hoặc hình ảnh thân mật không đồng thuận.",
  },
  {
    value: "child_safety",
    label: "An toàn trẻ em",
    description: "Trẻ vị thành niên trong ngữ cảnh tình dục, bóc lột, bạo lực hoặc nguy hiểm.",
  },
  {
    value: "hate_harassment",
    label: "Thù ghét hoặc quấy rối",
    description: "Lăng mạ, đe dọa, bắt nạt hoặc nhắm tới một nhóm được bảo vệ.",
  },
  {
    value: "self_harm",
    label: "Tự làm hại bản thân",
    description: "Tự sát, tự gây thương tích hoặc hành vi nguy hiểm với bản thân.",
  },
  {
    value: "illegal_dangerous",
    label: "Phi pháp hoặc nguy hiểm",
    description: "Vũ khí, chất cấm, phạm tội, khủng bố hoặc hướng dẫn hành vi nguy hiểm.",
  },
  {
    value: "rights_identity",
    label: "Quyền riêng tư hoặc danh tính",
    description: "Người thật, mạo danh, sinh trắc học, quyền riêng tư hoặc tài sản trí tuệ.",
  },
  {
    value: "deception",
    label: "Lừa đảo hoặc thông tin sai lệch",
    description: "Gian lận, lừa đảo, tuyên bố gây hiểu nhầm hoặc nội dung chính trị nhạy cảm.",
  },
  {
    value: "other",
    label: "Khác / không rõ",
    description: "Dùng ô chi tiết để nhập đúng nội dung Flow hiển thị.",
  },
] as const;

type PolicyReason = (typeof POLICY_REASON_OPTIONS)[number]["value"];

interface PolicyRepairModalState {
  sceneId: string;
  mediaType: SceneMediaType;
  detectedError: string;
}

const SCRIPT_OUTPUT_OPTIONS: Array<{
  value: TimelineOutputTarget;
  title: string;
  description: string;
}> = [
  {
    value: "prompts",
    title: "Chỉ tạo prompt",
    description: "Tạo timeline và prompt để kiểm tra trước khi sản xuất.",
  },
  {
    value: "images",
    title: "Storyboard ảnh",
    description: "Mỗi cảnh có một prompt ảnh và được đưa vào hàng đợi tạo ảnh.",
  },
  {
    value: "video",
    title: "Video hoàn chỉnh",
    description: "Mặc định gửi prompt trực tiếp sang Google Flow Video.",
  },
];

const SCRIPT_VIDEO_SOURCE_OPTIONS: Array<{
  value: TimelineVideoSourceMode;
  title: string;
  description: string;
}> = [
  {
    value: "direct",
    title: "Tạo video trực tiếp",
    description: "Gửi prompt thẳng sang Google Flow Video; không cần tạo ảnh trước.",
  },
  {
    value: "image-first",
    title: "Ảnh trước, video sau",
    description: "Tạo storyboard ảnh, duyệt frame mở đầu rồi mới tạo video.",
  },
];

const PROMPT_FILE_VIDEO_MODE_OPTIONS: Array<{
  value: PromptFileVideoMode;
  title: string;
  description: string;
}> = [
  {
    value: "direct-download",
    title: "Tạo & tải về app",
    description: "Chờ Flow render và lưu video vào project để progress, preview và dựng video hoạt động.",
  },
  {
    value: "direct-submit",
    title: "Gửi nhanh sang Flow",
    description: "Chỉ gửi prompt; dùng khi muốn để Flow render trên web trước rồi thu thập sau.",
  },
  {
    value: "connected-chain",
    title: "Connected Chain",
    description: "Tạo frame mở đầu, tải video, trích frame cuối và dùng làm frame đầu cho clip sau.",
  },
];

const SCRIPT_PACING_OPTIONS: Array<{
  value: TimelinePacing;
  title: string;
  description: string;
}> = [
  { value: "quick", title: "Nhanh", description: "Nhiều thông tin trong mỗi phút" },
  { value: "balanced", title: "Cân bằng", description: "Phù hợp đa số nội dung" },
  { value: "cinematic", title: "Điện ảnh", description: "Nhiều thời gian cho hình ảnh" },
];

function compactDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} phút ${remainder} giây` : `${remainder} giây`;
}

function isDirectScriptVideoWorkflow(source: TimelineWorkflowSource): boolean {
  return source.sourceKind === "script" &&
    (source.outputTarget || "video") === "video" &&
    (source.videoSourceMode || "direct") === "direct";
}

function loadStoredScenes(): Scene[] {
  try {
    const value = JSON.parse(localStorage.getItem(TIMELINE_STORAGE_KEY) || "[]");
    return normalizeStoredScenes(value);
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function isDetectedPolicyError(value: string | undefined): boolean {
  return /policy|safety|moderation|responsible\s+ai|prohibited|violation|blocked.{0,30}prompt|prompt.{0,30}blocked|vi\s*phạm|chính\s*sách/i.test(
    value || "",
  );
}

function applyQueueSnapshotToScenes(
  scenes: Scene[],
  snapshot: ProductionQueueSnapshot,
): Scene[] {
  const byId = new Map(snapshot.scenes.map((scene) => [scene.sceneId, scene]));
  return scenes.map((scene) => {
    const queued = byId.get(scene.id);
    if (!queued) return scene;
    const imageNeedsReview = queued.status === "needs_review" &&
      Boolean(queued.imageAssetPath) &&
      !queued.videoAssetPath;
    const videoNeedsReview = queued.status === "needs_review" && Boolean(queued.videoAssetPath);
    const imageStatus = queued.status === "image_failed"
      ? "error"
      : queued.status === "image_queued"
        ? "queued"
        : queued.status === "image_generating"
        ? "generating"
        : imageNeedsReview
          ? "review"
        : queued.imageAssetPath
          ? "done"
          : "pending";
    const videoStatus = queued.status === "video_failed"
      ? "error"
      : queued.status === "video_queued"
        ? "queued"
        : queued.status === "video_generating"
        ? "generating"
        : queued.status === "video_submitted"
        ? "submitted"
        : videoNeedsReview
          ? "review"
        : queued.videoAssetPath
          ? "done"
          : "pending";
    return {
      ...scene,
      imageStatus,
      imageResultPath: queued.imageAssetPath,
      imageFlowAssetKey: queued.flowImageAssetId,
      imageApproved: queued.approvedImage,
      videoStatus,
      videoResultPath: queued.videoAssetPath,
      videoApproved: queued.approvedVideo,
    };
  });
}

function FilePicker({
  id,
  label,
  accept,
  file,
  savedName,
  onChange,
}: {
  id: string;
  label: string;
  accept: string;
  file: File | null;
  savedName?: string;
  onChange: (file: File | null) => void;
}) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.files?.[0] || null);
  };

  return (
    <div className={`timeline-file ${file || savedName ? "has-file" : ""}`}>
      <div className="timeline-file-icon" aria-hidden="true">
        <FileText size={20} />
      </div>
      <div className="timeline-file-details">
        <strong>{label}</strong>
        <span>{file
          ? `${file.name} · ${formatBytes(file.size)}`
          : savedName
            ? `${savedName} · đã lưu trong phiên`
            : "Chưa chọn file"}</span>
      </div>
      <label className="button secondary compact" htmlFor={id}>
        <Upload size={15} aria-hidden="true" />
        Chọn file
      </label>
      <input
        key={file ? `${file.name}-${file.size}` : "empty"}
        id={id}
        className="visually-hidden-file"
        type="file"
        accept={accept}
        onChange={handleChange}
      />
    </div>
  );
}

function PromptFileReviewCard({
  pathCandidate,
  review,
  loadingPath,
  disabled,
  timelineApplied,
  videoMode,
  onLoadPath,
  onVideoModeChange,
  onImport,
  onImportAndRun,
}: {
  pathCandidate: string | null;
  review: PromptFileImportResult | null;
  loadingPath: boolean;
  disabled: boolean;
  timelineApplied: boolean;
  videoMode: PromptFileVideoMode;
  onLoadPath: () => void;
  onVideoModeChange: (mode: PromptFileVideoMode) => void;
  onImport: () => void;
  onImportAndRun: () => void;
}) {
  const blockingIssues = review?.issues.filter((issue) => issue.severity === "blocking") || [];
  const warnings = review?.issues.filter((issue) => issue.severity === "warning") || [];
  const infoIssues = review?.issues.filter((issue) => issue.severity === "info") || [];
  const visibleIssues: PromptFileImportIssue[] = [...blockingIssues, ...warnings, ...infoIssues].slice(0, 5);

  if (pathCandidate) {
    return (
      <section className="prompt-file-review is-path" aria-label="Đường dẫn prompt file">
        <header>
          <div>
            <p className="eyebrow">Prompt file</p>
            <h4>Đã nhận diện đường dẫn file</h4>
            <p>{pathCandidate}</p>
          </div>
          <span><FileText size={14} /> .txt/.md</span>
        </header>
        <footer>
          <button className="button secondary compact" type="button" disabled={disabled || loadingPath} onClick={onLoadPath}>
            {loadingPath ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
            Đọc và kiểm tra file
          </button>
        </footer>
      </section>
    );
  }

  if (!review) return null;

  return (
    <section className={`prompt-file-review ${blockingIssues.length ? "has-blocking" : "is-ready"}`} aria-label="Kiểm tra prompt file">
      <header>
        <div>
          <p className="eyebrow">Timeline có sẵn</p>
          <h4>{review.summary.clipCount} clip video · {compactDuration(review.summary.totalDurationSeconds)}</h4>
          <p>{review.sourceName} được nhận diện là danh sách prompt Google Flow, mỗi dòng là một clip.</p>
        </div>
        <span className={blockingIssues.length ? "is-blocked" : "is-ready"}>
          {blockingIssues.length ? <CircleAlert size={14} /> : <Check size={14} />}
          {blockingIssues.length ? "Cần sửa" : timelineApplied ? "Đã import" : "Sẵn sàng"}
        </span>
      </header>

      <div className="prompt-file-stats">
        <article><strong>{review.summary.clipCount}</strong><span>clip</span></article>
        <article><strong>{compactDuration(review.summary.totalDurationSeconds)}</strong><span>tổng thời lượng</span></article>
        <article><strong>{review.summary.averagePromptChars.toLocaleString("vi-VN")}</strong><span>ký tự trung bình</span></article>
        <article><strong>{review.summary.metadataStrippedCount}</strong><span>CLIP metadata được tách</span></article>
      </div>

      <div className="prompt-file-mode-options" role="group" aria-label="Chế độ tạo video từ prompt file">
        {PROMPT_FILE_VIDEO_MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={videoMode === option.value ? "is-selected" : ""}
            type="button"
            disabled={disabled || timelineApplied}
            aria-pressed={videoMode === option.value}
            onClick={() => onVideoModeChange(option.value)}
          >
            <strong>{option.title}</strong>
            <small>{option.description}</small>
          </button>
        ))}
      </div>

      {visibleIssues.length > 0 && (
        <div className="prompt-file-issues">
          {visibleIssues.map((issue, index) => (
            <p key={`${issue.code}-${index}`} className={`is-${issue.severity}`}>
              {issue.severity === "blocking" ? <CircleAlert size={14} /> : <ShieldCheck size={14} />}
              <span>{issue.message}</span>
            </p>
          ))}
        </div>
      )}

      <footer>
        <button
          className="button secondary compact"
          type="button"
          disabled={disabled || blockingIssues.length > 0 || timelineApplied}
          onClick={onImport}
        >
          <FileText size={14} />
          {timelineApplied ? "Đã import timeline" : "Import để review"}
        </button>
        <button
          className="button primary compact"
          type="button"
          disabled={disabled || blockingIssues.length > 0}
          onClick={onImportAndRun}
        >
          <Clapperboard size={14} />
          {timelineApplied ? "Chạy video trực tiếp" : "Import & tạo video"}
        </button>
      </footer>
    </section>
  );
}

const STATUS_LABELS = {
  pending: "Chờ",
  queued: "Trong hàng đợi",
  generating: "Đang chạy",
  submitted: "Đã gửi Flow",
  done: "Hoàn tất",
  review: "Cần làm lại",
  error: "Lỗi",
} as const;

function SceneStatusCell({
  scene,
  mediaType,
  error,
  onRun,
  onAlternative,
  disabled = false,
  disabledTitle,
  approved = false,
  onApprove,
  onReject,
}: {
  scene: Scene;
  mediaType: SceneMediaType;
  error?: string;
  onRun: () => void;
  onAlternative: () => void;
  disabled?: boolean;
  disabledTitle?: string;
  approved?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const status = mediaType === "image" ? scene.imageStatus : scene.videoStatus;
  const busy = status === "generating";
  return (
    <div className={`scene-job-cell is-${mediaType} is-${status} ${approved ? "is-approved" : ""}`}>
      <span className={`scene-status is-${status}`} title={error || STATUS_LABELS[status]}>
        {busy ? <LoaderCircle className="spin" size={13} /> : status === "submitted" ? <Upload size={13} /> : status === "done" ? <Check size={13} /> : status === "error" ? <CircleAlert size={13} /> : null}
        {STATUS_LABELS[status]}
      </span>
      {approved && <small className="scene-approved"><Check size={12} /> Đã duyệt</small>}
      {error && <small className="scene-job-error" role="alert">{error}</small>}
      <div className="scene-job-actions">
        <button className="icon-button compact-icon" type="button" title={disabledTitle || `Tạo lại ${mediaType === "image" ? "ảnh" : "video"}`} disabled={busy || disabled} onClick={onRun}>
          <RotateCcw size={14} aria-hidden="true" />
        </button>
        <button className="icon-button compact-icon" type="button" title={disabledTitle || "Dùng prompt khác"} disabled={busy || disabled} onClick={onAlternative}>
          <PencilLine size={14} aria-hidden="true" />
        </button>
        {(status === "done" || status === "review") && !approved && onApprove && (
          <>
            <button className="icon-button compact-icon approve-icon" type="button" title="Duyệt kết quả" onClick={onApprove}>
              <Check size={14} aria-hidden="true" />
            </button>
            {status === "done" && onReject && (
              <button className="icon-button compact-icon reject-icon" type="button" title="Từ chối · đánh dấu cần làm lại" onClick={onReject}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TimelineTable({
  scenes,
  errors,
  thumbnails,
  onPromptChange,
  onPlanningChange,
  onRun,
  onRegenerate,
  onResumeFrom,
  onClearSceneMedia,
  onApprove,
  onReject,
  onRepairPolicy,
  repairingPromptKey,
  clearingSceneId,
  textWorkerConnected,
  textProviderLabel,
}: {
  scenes: Scene[];
  errors: Record<string, string>;
  thumbnails: Record<string, string>;
  onPromptChange: (sceneId: string, mediaType: SceneMediaType, prompt: string) => void;
  onPlanningChange: (
    sceneId: string,
    change: Partial<Pick<Scene, "chainId" | "chainRole" | "durationSeconds">>,
  ) => void;
  onRun: (sceneId: string, mediaType: SceneMediaType, prompt: string) => void;
  onRegenerate: (sceneId: string, mediaType: SceneMediaType) => void;
  onResumeFrom: (sceneId: string, mediaType: SceneMediaType) => void;
  onClearSceneMedia: (sceneId: string) => void;
  onApprove: (sceneId: string, mediaType: SceneMediaType) => void;
  onReject: (sceneId: string, mediaType: SceneMediaType) => void;
  onRepairPolicy: (sceneId: string, mediaType: SceneMediaType) => void;
  repairingPromptKey: string;
  clearingSceneId: string;
  textWorkerConnected: boolean;
  textProviderLabel: string;
}) {
  const [alternative, setAlternative] = useState<{ sceneId: string; mediaType: SceneMediaType } | null>(null);
  const [draft, setDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    sceneId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const openAlternative = (scene: Scene, mediaType: SceneMediaType) => {
    setAlternative({ sceneId: scene.id, mediaType });
    setDraft(mediaType === "image" ? scene.imagePrompt : scene.videoPrompt);
  };

  return (
    <div className="timeline-table-wrap">
      <table className="timeline-table">
        <thead>
          <tr>
            <th scope="col">Scene</th>
            <th scope="col">Chain</th>
            <th scope="col">Thời lượng</th>
            <th scope="col">Thumbnail</th>
            <th scope="col">Prompt ảnh</th>
            <th scope="col">Ảnh</th>
            <th scope="col">Prompt video</th>
            <th scope="col">Video</th>
            <th scope="col">Nhân vật</th>
          </tr>
        </thead>
        <tbody>
          {scenes.map((scene) => {
            const isAlternative = alternative?.sceneId === scene.id;
            const hasSceneWork = Boolean(
              scene.imageResultPath ||
              scene.videoResultPath ||
              scene.imageStatus !== "pending" ||
              scene.videoStatus !== "pending"
            );
            return [
              <tr
                key={scene.id}
                className={`timeline-scene-row is-image-${scene.imageStatus} is-video-${scene.videoStatus} ${errors[`${scene.id}:image`] || errors[`${scene.id}:video`] ? "has-error" : ""}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ sceneId: scene.id, x: event.clientX, y: event.clientY });
                }}
              >
                <td className="scene-identity">
                  <strong>{scene.order}</strong>
                  <span>{scene.timeStart}</span>
                  <span>{scene.timeEnd}</span>
                  <button
                    className="icon-button compact-icon danger-icon scene-delete-result"
                    type="button"
                    title="Xóa ảnh, video và job của riêng scene này; giữ nguyên prompt"
                    aria-label={`Xóa kết quả scene ${scene.order}`}
                    disabled={!hasSceneWork || Boolean(clearingSceneId)}
                    onClick={() => onClearSceneMedia(scene.id)}
                  >
                    {clearingSceneId === scene.id
                      ? <LoaderCircle className="spin" size={13} />
                      : <Trash2 size={13} />}
                  </button>
                </td>
                <td className="scene-chain-cell">
                  <select
                    aria-label={`Vai trò chain scene ${scene.order}`}
                    value={scene.chainRole}
                    onChange={(event) => onPlanningChange(scene.id, {
                      chainRole: event.target.value as SceneChainRole,
                    })}
                  >
                    <option value="single">Độc lập</option>
                    <option value="start">Bắt đầu</option>
                    <option value="continue">Tiếp nối</option>
                  </select>
                  <input
                    aria-label={`Mã chain scene ${scene.order}`}
                    value={scene.chainId || ""}
                    disabled={scene.chainRole === "single"}
                    placeholder="chain-001"
                    onChange={(event) => onPlanningChange(scene.id, { chainId: event.target.value })}
                  />
                </td>
                <td className="scene-duration-cell">
                  <select
                    aria-label={`Thời lượng scene ${scene.order}`}
                    value={scene.durationSeconds}
                    onChange={(event) => onPlanningChange(scene.id, {
                      durationSeconds: Number(event.target.value) as SceneDurationSeconds,
                    })}
                  >
                    {SCENE_DURATION_OPTIONS.map((seconds) => (
                      <option key={seconds} value={seconds}>{seconds} giây</option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className={`scene-thumbnail is-${scene.imageStatus}`}>
                    {thumbnails[scene.id]
                      ? <img src={thumbnails[scene.id]} alt={`Kết quả scene ${scene.order}`} loading="lazy" />
                      : scene.imageStatus === "generating"
                        ? <LoaderCircle className="spin" size={20} />
                        : scene.imageStatus === "done"
                          ? <Check size={22} />
                          : <ImageIcon size={22} />}
                  </div>
                </td>
                <td>
                  <div className="scene-prompt-cell" data-label="Prompt anh">
                    <textarea className="scene-prompt" aria-label={`Prompt ảnh scene ${scene.order}`} value={scene.imagePrompt} onChange={(event) => onPromptChange(scene.id, "image", event.target.value)} />
                    {Boolean(scene.imagePrompt.trim()) && (
                      <button
                        className="button secondary compact policy-repair-button"
                        type="button"
                        disabled={!textWorkerConnected || Boolean(repairingPromptKey)}
                        title={textWorkerConnected
                          ? isDetectedPolicyError(errors[`${scene.id}:image`])
                            ? `Đã có lỗi Flow: gửi thẳng lỗi sang ${textProviderLabel}, sửa prompt và chạy tiếp`
                            : "Chưa đọc được lỗi Flow: mở danh sách lý do để bạn chọn"
                          : `${textProviderLabel} worker chưa kết nối`}
                        onClick={() => onRepairPolicy(scene.id, "image")}
                      >
                        {repairingPromptKey === `${scene.id}:image` ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                        {isDetectedPolicyError(errors[`${scene.id}:image`]) ? "Sửa nhanh theo lỗi Flow" : "Sửa chính sách"}
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <SceneStatusCell
                    scene={scene}
                    mediaType="image"
                    error={errors[`${scene.id}:image`]}
                    approved={scene.imageApproved}
                    onRun={() => onRun(scene.id, "image", scene.imagePrompt)}
                    onAlternative={() => openAlternative(scene, "image")}
                    onApprove={() => onApprove(scene.id, "image")}
                    onReject={() => onReject(scene.id, "image")}
                  />
                </td>
                <td>
                  <div className="scene-prompt-cell" data-label="Prompt video">
                    <textarea className="scene-prompt" aria-label={`Prompt video scene ${scene.order}`} value={scene.videoPrompt} onChange={(event) => onPromptChange(scene.id, "video", event.target.value)} />
                    {Boolean(scene.videoPrompt.trim()) && (
                      <button
                        className="button secondary compact policy-repair-button"
                        type="button"
                        disabled={!textWorkerConnected || Boolean(repairingPromptKey)}
                        title={textWorkerConnected
                          ? isDetectedPolicyError(errors[`${scene.id}:video`])
                            ? `Đã có lỗi Flow: gửi thẳng lỗi sang ${textProviderLabel}, sửa prompt và chạy tiếp`
                            : "Chưa đọc được lỗi Flow: mở danh sách lý do để bạn chọn"
                          : `${textProviderLabel} worker chưa kết nối`}
                        onClick={() => onRepairPolicy(scene.id, "video")}
                      >
                        {repairingPromptKey === `${scene.id}:video` ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                        {isDetectedPolicyError(errors[`${scene.id}:video`]) ? "Sửa nhanh theo lỗi Flow" : "Sửa chính sách"}
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <SceneStatusCell
                    scene={scene}
                    mediaType="video"
                    error={errors[`${scene.id}:video`]}
                    disabled={scene.imageStatus !== "done" || !scene.imageResultPath}
                    disabledTitle="Cần tạo xong ảnh scene trước khi tạo video"
                    approved={scene.videoApproved}
                    onRun={() => onRun(scene.id, "video", scene.videoPrompt)}
                    onAlternative={() => openAlternative(scene, "video")}
                    onApprove={() => onApprove(scene.id, "video")}
                    onReject={() => onReject(scene.id, "video")}
                  />
                </td>
                <td>
                  <div className="scene-tokens">
                    {scene.characterPolicy === "selected" && scene.assignedCharacterTokens.length > 0
                      ? scene.assignedCharacterTokens.map((token) => <span key={token}>{token}</span>)
                      : <span className="no-character">Không</span>}
                  </div>
                </td>
              </tr>,
              isAlternative ? (
                <tr className="scene-alternative-row" key={`${scene.id}-alternative`}>
                  <td colSpan={9}>
                    <div className="scene-alternative-editor">
                      <div>
                        <strong>Prompt {alternative.mediaType === "image" ? "ảnh" : "video"} thay thế · Scene {scene.order}</strong>
                        <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
                      </div>
                      <div className="scene-alternative-actions">
                        <button className="icon-button" type="button" title="Hủy" onClick={() => setAlternative(null)}><X size={16} /></button>
                        <button className="button primary" type="button" disabled={!draft.trim()} onClick={() => { onPromptChange(scene.id, alternative.mediaType, draft); onRun(scene.id, alternative.mediaType, draft); setAlternative(null); }}>
                          <Save size={15} /> Dùng prompt này
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
      {contextMenu && (
        <div
          className="scene-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <strong>{contextMenu.sceneId}</strong>
          <button type="button" role="menuitem" onClick={() => { onResumeFrom(contextMenu.sceneId, "image"); setContextMenu(null); }}>
            Resume ảnh từ đây
          </button>
          <button type="button" role="menuitem" onClick={() => { onResumeFrom(contextMenu.sceneId, "video"); setContextMenu(null); }}>
            Resume video từ đây
          </button>
          <button type="button" role="menuitem" onClick={() => { onRegenerate(contextMenu.sceneId, "image"); setContextMenu(null); }}>
            Tạo lại ảnh chỉ scene này
          </button>
          <button type="button" role="menuitem" onClick={() => { onRegenerate(contextMenu.sceneId, "video"); setContextMenu(null); }}>
            Tạo lại video chỉ scene này
          </button>
        </div>
      )}
    </div>
  );
}

const ERROR_CATEGORY_LABELS: Record<QueueErrorView["category"], string> = {
  dom_element_not_found: "Không tìm thấy phần tử Flow",
  flow_policy_violation: "Vi phạm chính sách Flow",
  flow_generation_failed: "Flow không tạo được video",
  response_schema_invalid: "Phản hồi không hợp lệ",
  timeout_no_response: "Quá thời gian phản hồi",
  flow_quota_or_rate_limit: "Giới hạn Google Flow",
  extension_disconnected: "Extension mất kết nối",
};

function ErrorCenter({
  errors,
  onRetry,
}: {
  errors: QueueErrorView[];
  onRetry: (sceneIds: string[]) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <section className="error-center" aria-labelledby="error-center-title">
      <header>
        <div>
          <p className="eyebrow">Production queue</p>
          <h3 id="error-center-title">Error Center · {errors.length} lỗi</h3>
        </div>
        <button
          className="button secondary compact"
          type="button"
          onClick={() => onRetry([...new Set(errors.map((item) => item.sceneId))])}
        >
          <RotateCcw size={14} /> Thử lại lỗi
        </button>
      </header>
      <div className="error-center-list">
        {errors.map((item) => (
          <article key={item.jobId}>
            <CircleAlert size={17} aria-hidden="true" />
            <div>
              <strong>Scene {item.orderIndex + 1} · {item.mediaType === "image" ? "Ảnh" : "Video"}</strong>
              <span>{ERROR_CATEGORY_LABELS[item.category]} · lần {item.attempts}/{item.maxAttempts}</span>
              <p>{item.message}</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => onRetry([item.sceneId])}
            >
              Thử lại
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TimelineImport({
  workers,
  integratedHandoff = null,
  onIntegratedHandoffConsumed,
  onWorkflowReady,
  onBuildVideo,
  onBack,
}: TimelineImportProps) {
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [workflowMode, setWorkflowMode] = useState<VideoWorkflowMode>("two_step");
  const [workflowSource, setWorkflowSource] = useState<TimelineWorkflowSource>(
    () => structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE),
  );
  const [workflowNotice, setWorkflowNotice] = useState("");
  const [textProvider, setTextProvider] = useState<TextProvider>(
    DEFAULT_PROVIDER_SETTINGS.textProvider,
  );
  const [scenes, setScenes] = useState<Scene[]>(loadStoredScenes);
  const [visualBible, setVisualBible] = useState<VisualBible>(() => structuredClone(DEFAULT_VISUAL_BIBLE));
  const [styleReference, setStyleReference] = useState<TimelineStyleReference | null>(null);
  const [sessions, setSessions] = useState<TimelineSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(DEFAULT_PROJECT_ID);
  const [sessionNameDraft, setSessionNameDraft] = useState("Phiên làm việc");
  const [switchingSession, setSwitchingSession] = useState(false);
  const [characters, setCharacters] = useState<CharacterView[]>([]);
  const [stylePresets, setStylePresets] = useState<GraphicStylePreset[]>([]);
  const [stylePresetError, setStylePresetError] = useState("");
  const [imageModal, setImageModal] = useState<{ sceneId: string; prompt: string } | null>(null);
  const [videoModal, setVideoModal] = useState<{ sceneId: string; prompt: string } | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [clearMediaConfirmOpen, setClearMediaConfirmOpen] = useState(false);
  const [clearingGeneratedMedia, setClearingGeneratedMedia] = useState(false);
  const [clearSceneMediaTarget, setClearSceneMediaTarget] = useState<string | null>(null);
  const [clearingSceneId, setClearingSceneId] = useState("");
  const [clearMediaNotice, setClearMediaNotice] = useState("");
  const [progress, setProgress] = useState<TimelineProgress | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [promptFilePathLoading, setPromptFilePathLoading] = useState(false);
  const [promptFileVideoMode, setPromptFileVideoMode] = useState<PromptFileVideoMode>("direct-download");
  const [sceneErrors, setSceneErrors] = useState<Record<string, string>>({});
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<
    "loading" | "saving" | "saved" | "error"
  >("loading");
  const [queueSnapshot, setQueueSnapshot] = useState<ProductionQueueSnapshot | null>(null);
  const [queueCommandError, setQueueCommandError] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [repairingPromptKey, setRepairingPromptKey] = useState("");
  const [policyRepairModal, setPolicyRepairModal] = useState<PolicyRepairModalState | null>(null);
  const [policyReason, setPolicyReason] = useState<PolicyReason>("auto");
  const [policyDetail, setPolicyDetail] = useState("");
  const sessionSaveVersion = useRef(0);
  const settledSceneJobs = useRef(new Set<string>());
  const sceneJobSessions = useRef(new Map<string, string>());
  const activeSessionIdRef = useRef(activeSessionId);
  const consumedHandoffIds = useRef(new Set<string>());
  const loadedThumbnailPaths = useRef(new Map<string, string>());
  const timelineRootRef = useRef<HTMLElement>(null);
  const activeProjectId = activeSessionId || DEFAULT_PROJECT_ID;
  const imageProvider = queueSnapshot?.imageProvider || DEFAULT_IMAGE_GENERATION_PROVIDER;
  const videoProvider = queueSnapshot?.videoProvider || DEFAULT_VIDEO_GENERATION_PROVIDER;
  const imageProviderConnected = workers[IMAGE_PROVIDER_WORKER_ROLE[imageProvider]]?.connected === true;
  const videoProviderConnected = workers[VIDEO_PROVIDER_WORKER_ROLE[videoProvider]]?.connected === true;
  const imageProviderLabel = IMAGE_PROVIDER_LABEL[imageProvider];
  const videoProviderLabel = VIDEO_PROVIDER_LABEL[videoProvider];
  const textWorkerRole = TEXT_PROVIDER_WORKER_ROLE[textProvider];
  const textWorkerConnected = workers[textWorkerRole]?.connected === true;
  const textProviderLabel = TEXT_PROVIDER_LABEL[textProvider];

  useEffect(() => {
    if (scenes.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const dashboard = timelineRootRef.current?.querySelector<HTMLElement>(".workflow-dashboard");
      dashboard?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scenes.length]);

  useEffect(() => {
    let active = true;
    void window.flowx?.providerSettings.get().then(
      (settings) => {
        if (active) setTextProvider(settings.textProvider);
      },
      () => {
        if (active) setTextProvider(DEFAULT_PROVIDER_SETTINGS.textProvider);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const applySession = (session: TimelineSession) => {
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setSessionNameDraft(session.name);
    setScenes(session.scenes);
    setVisualBible(session.visualBible);
    setStyleReference(session.styleReference);
    setWorkflowMode(session.workflowMode);
    setWorkflowSource(session.workflowSource);
    setPromptFileVideoMode(session.workflowSource.promptFileVideoMode || "direct-download");
    setWorkflowNotice("");
    setSrtFile(null);
    setScriptFile(null);
    setProgress(null);
    setError("");
    setSceneErrors({});
    setThumbnails({});
    setImageModal(null);
    setVideoModal(null);
    const restoredSceneId = localStorage.getItem(`vyren-ai:selected-scene:${session.id}`) || "";
    const nextSceneId = session.scenes.some((scene) => scene.id === restoredSceneId)
      ? restoredSceneId
      : session.scenes[0]?.id || "";
    setSelectedSceneId(nextSceneId);
    setClearSceneMediaTarget(null);
    setClearingSceneId("");
    loadedThumbnailPaths.current.clear();
    settledSceneJobs.current.clear();
    sceneJobSessions.current.clear();
  };

  useEffect(() => {
    let active = true;
    void window.flowx?.characters.list().then(
      (items) => { if (active) setCharacters(items); },
      () => { if (active) setCharacters([]); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void window.flowx?.visualStyles.list().then(
      (items) => { if (active) setStylePresets(items); },
      (caught) => { if (active) setStylePresetError(errorMessage(caught)); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const media = window.flowx?.media;
    if (!media) return;
    const sessionId = activeProjectId;
    const currentPaths = new Map(
      scenes
        .filter((scene) => scene.imageStatus === "done" && Boolean(scene.imageResultPath))
        .map((scene) => [scene.id, scene.imageResultPath] as const),
    );
    for (const [sceneId, path] of loadedThumbnailPaths.current) {
      if (currentPaths.get(sceneId) !== path) loadedThumbnailPaths.current.delete(sceneId);
    }
    setThumbnails((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([sceneId]) => currentPaths.has(sceneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    for (const scene of scenes) {
      const path = scene.imageResultPath;
      if (
        scene.imageStatus !== "done" ||
        !path ||
        path.startsWith("mock://") ||
        loadedThumbnailPaths.current.get(scene.id) === path
      ) {
        continue;
      }
      loadedThumbnailPaths.current.set(scene.id, path);
      void media.getStreamUrl(path).then(
        (streamUrl) => {
          if (
            activeSessionIdRef.current !== sessionId ||
            loadedThumbnailPaths.current.get(scene.id) !== path
          ) return;
          setThumbnails((current) => ({ ...current, [scene.id]: streamUrl }));
        },
        () => {
          if (loadedThumbnailPaths.current.get(scene.id) === path) {
            loadedThumbnailPaths.current.delete(scene.id);
          }
        },
      );
    }
  }, [activeProjectId, scenes]);

  useEffect(() => {
    let active = true;

    const restoreSession = async () => {
      const bridge = window.flowx?.timeline;
      if (!bridge) {
        if (active) {
          setSessionReady(true);
          setSessionStatus("error");
        }
        return;
      }

      try {
        let availableSessions = await bridge.listSessions();
        let stored = await bridge.loadSession();
        if (!stored) {
          stored = await bridge.createSession("Phiên 1");
          availableSessions = await bridge.listSessions();
        }
        if (!active) return;
        if (stored.scenes.length) {
          applySession(stored);
        } else {
          const legacyScenes = loadStoredScenes();
          if (legacyScenes.length > 0) {
            const migrated = await bridge.saveSession({
              scenes: legacyScenes,
              visualBible: structuredClone(DEFAULT_VISUAL_BIBLE),
              styleReference: null,
            });
            if (!active) return;
            applySession(migrated);
          } else {
            applySession(stored);
          }
        }
        setSessions(availableSessions);
        localStorage.removeItem(TIMELINE_STORAGE_KEY);
        setSessionStatus("saved");
      } catch {
        if (active) setSessionStatus("error");
      } finally {
        if (active) setSessionReady(true);
      }
    };

    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const bridge = window.flowx?.timeline;
    if (!bridge) return undefined;
    return bridge.onProgress(setProgress);
  }, []);

  useEffect(() => {
    const bridge = window.flowx?.sceneJobs;
    if (!bridge) return undefined;
    return bridge.onProgress((job: SceneJobProgress) => {
      const key = `${job.sceneId}:${job.mediaType}`;
      if (
        settledSceneJobs.current.has(key) ||
        sceneJobSessions.current.get(key) !== activeSessionIdRef.current
      ) return;
      setScenes((current) =>
        current.map((scene) => {
          if (scene.id !== job.sceneId) return scene;
          const status = job.status === "stopping" ? "pending" : "generating";
          return job.mediaType === "image"
            ? { ...scene, imageStatus: status }
            : { ...scene, videoStatus: status };
        }),
      );
    });
  }, []);

  useEffect(() => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return undefined;
    const applySnapshot = (snapshot: ProductionQueueSnapshot) => {
      if (snapshot.projectId !== activeSessionIdRef.current) return;
      setQueueSnapshot(snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, snapshot));
      setSceneErrors((current) => {
        const next = { ...current };
        for (const scene of snapshot.scenes) {
          if (scene.status !== "image_failed") delete next[`${scene.sceneId}:image`];
          if (scene.status !== "video_failed") delete next[`${scene.sceneId}:video`];
        }
        for (const queueError of snapshot.errors) {
          next[`${queueError.sceneId}:${queueError.mediaType}`] = queueError.message;
        }
        return next;
      });
    };
    void bridge.getSnapshot(activeProjectId).then(applySnapshot, () => {});
    return bridge.onChanged(applySnapshot);
  }, [activeProjectId]);

  useEffect(() => {
    // Clearing generated media performs its own ordered session writes. Pause
    // the debounced renderer autosave so an older scene snapshot cannot be
    // queued behind the clear operation and restore deleted result paths.
    if (!sessionReady || clearingGeneratedMedia || Boolean(clearingSceneId)) return undefined;
    const saveVersion = ++sessionSaveVersion.current;
    setSessionStatus("saving");
    const timer = window.setTimeout(() => {
      const bridge = window.flowx?.timeline;
      if (!bridge) return;
      const operation = bridge.saveSession({
        scenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      void operation.then(
        (saved) => {
          localStorage.removeItem(TIMELINE_STORAGE_KEY);
          setSessions((current) => current.map((entry) => entry.id === saved.id
            ? { ...entry, name: saved.name, sceneCount: saved.scenes.length, savedAt: saved.savedAt, active: true }
            : { ...entry, active: false }));
          if (sessionSaveVersion.current === saveVersion) {
            setSessionStatus("saved");
          }
        },
        () => {
          if (sessionSaveVersion.current === saveVersion) {
            setSessionStatus("error");
          }
        },
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    scenes,
    visualBible,
    styleReference,
    workflowMode,
    workflowSource,
    sessionReady,
    clearingGeneratedMedia,
    clearingSceneId,
  ]);

  const validateFile = (
    file: File | null,
    label: string,
    extensions: string[],
  ): file is File => {
    if (!file) {
      setError(`Hãy chọn ${label.toLowerCase()}`);
      return false;
    }
    if (file.size > MAX_TIMELINE_FILE_BYTES) {
      setError(`${label} vượt quá giới hạn 2 MB`);
      return false;
    }
    if (!extensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
      setError(`${label} phải có định dạng ${extensions.join(" hoặc ")}`);
      return false;
    }
    return true;
  };

  const updatePrompt = (
    sceneId: string,
    mediaType: SceneMediaType,
    prompt: string,
  ) => {
    setScenes((current) =>
      current.map((scene) => {
        if (scene.id !== sceneId) return scene;
        const next = mediaType === "image"
          ? { ...scene, imagePrompt: prompt }
          : { ...scene, videoPrompt: prompt };
        return {
          ...next,
          usedCharacterTokens: parseCharacterTokens(
            `${next.imagePrompt}\n${next.videoPrompt}`,
          ),
        };
      }),
    );
  };

  const selectScene = (sceneId: string) => {
    setSelectedSceneId(sceneId);
    localStorage.setItem(`vyren-ai:selected-scene:${activeProjectId}`, sceneId);
  };

  const saveCurrentSession = async () => {
    const bridge = window.flowx?.timeline;
    if (!bridge) return;
    setSessionStatus("saving");
    try {
      await bridge.saveSession({ scenes, visualBible, styleReference, workflowMode, workflowSource });
      setSessionStatus("saved");
    } catch (caught) {
      setSessionStatus("error");
      setQueueCommandError(errorMessage(caught));
    }
  };

  const updatePlanning = (
    sceneId: string,
    change: Partial<Pick<Scene, "chainId" | "chainRole" | "durationSeconds">>,
  ) => {
    setScenes((current) => recalculateScenePlanning(current, sceneId, change));
  };

  const executeSceneJob = async (
    sceneId: string,
    mediaType: SceneMediaType,
    prompt: string,
    characterTokens: string[] = [],
    videoMode: "text-to-video" | "first-frame" = "first-frame",
  ) => {
    const key = `${sceneId}:${mediaType}`;
    const jobSessionId = activeSessionIdRef.current;
    sceneJobSessions.current.set(key, jobSessionId);
    settledSceneJobs.current.delete(key);
    setSceneErrors((current) => ({ ...current, [key]: "" }));
    const requiredConnected = mediaType === "image" ? imageProviderConnected : videoProviderConnected;
    const requiredWorkerLabel = mediaType === "image" ? imageProviderLabel : videoProviderLabel;
    if (!requiredConnected || !window.flowx?.sceneJobs) {
      setSceneErrors((current) => ({
        ...current,
        [key]: `${requiredWorkerLabel} worker chưa kết nối`,
      }));
      setScenes((current) => current.map((scene) => scene.id === sceneId
        ? mediaType === "image"
          ? { ...scene, imageStatus: "error" }
          : { ...scene, videoStatus: "error" }
        : scene));
      return;
    }

    setScenes((current) => current.map((scene) => scene.id === sceneId
      ? mediaType === "image"
        ? { ...scene, imageStatus: "generating" }
        : { ...scene, videoStatus: "generating" }
      : scene));
    try {
      const sourceScene = scenes.find((scene) => scene.id === sceneId);
      const directVideo = mediaType === "video" && videoMode === "text-to-video";
      const result = await window.flowx.sceneJobs.run({
        sceneId,
        outputFolder: projectOutputFolder(activeProjectId, sessionNameDraft),
        mediaType,
        prompt: prompt.trim(),
        characterTokens: mediaType === "image" ? characterTokens : [],
        visualBible,
        imageSettings: {
          provider: imageProvider,
          model: imageModelForProvider(imageProvider),
          aspectRatio: visualBible.aspectRatio,
          outputCount: 1,
          expectedCredits: 0,
        },
        sourceImagePath: mediaType === "video" && !directVideo ? sourceScene?.imageResultPath || "" : "",
        sourceFlowAssetKey: mediaType === "video" && !directVideo ? sourceScene?.imageFlowAssetKey || "" : "",
        startFramePath: "",
        videoSettings: {
          provider: videoProvider,
          model: videoModelForProvider(videoProvider),
          mode: mediaType === "video" ? videoMode : "first-frame",
          delivery: "download",
          aspectRatio: visualBible.aspectRatio,
          durationSeconds: sourceScene?.durationSeconds || 8,
          outputCount: 1,
          expectedCredits: 0,
        },
      });
      if (activeSessionIdRef.current !== jobSessionId) return;
      settledSceneJobs.current.add(key);
      setScenes((current) => current.map((scene) => scene.id === sceneId
        ? mediaType === "image"
          ? {
            ...scene,
            imageStatus: "done",
            imageResultPath: result.resultPath,
            imageFlowAssetKey: result.flowAssetKey,
            imageApproved: false,
            videoStatus: "pending",
            videoResultPath: "",
            videoApproved: false,
          }
          : result.status === "submitted"
          ? { ...scene, videoStatus: "submitted", videoResultPath: "", videoApproved: false }
          : { ...scene, videoStatus: "done", videoResultPath: result.resultPath, videoApproved: false }
        : scene));
    } catch (caught) {
      if (activeSessionIdRef.current !== jobSessionId) return;
      settledSceneJobs.current.add(key);
      setSceneErrors((current) => ({ ...current, [key]: errorMessage(caught) }));
      setScenes((current) => current.map((scene) => scene.id === sceneId
        ? mediaType === "image"
          ? { ...scene, imageStatus: "error" }
          : { ...scene, videoStatus: "error" }
        : scene));
    }
  };

  const requestSceneJob = (
    sceneId: string,
    mediaType: SceneMediaType,
    prompt: string,
  ) => {
    if (mediaType === "image") {
      setImageModal({ sceneId, prompt });
      return;
    }
    setVideoModal({ sceneId, prompt });
  };

  const confirmImageGeneration = (value: {
    prompt: string;
    characterPolicy: Scene["characterPolicy"];
    characterTokens: string[];
  }) => {
    if (!imageModal) return;
    const { sceneId } = imageModal;
    setScenes((current) => current.map((scene) => scene.id === sceneId
      ? {
        ...scene,
        imagePrompt: value.prompt,
        characterPolicy: value.characterPolicy,
        assignedCharacterTokens: value.characterTokens,
      }
      : scene));
    setImageModal(null);
    void executeSceneJob(sceneId, "image", value.prompt, value.characterTokens);
  };

  const confirmVideoGeneration = (prompt: string, videoMode: "text-to-video" | "first-frame") => {
    if (!videoModal) return;
    const { sceneId } = videoModal;
    setScenes((current) => current.map((scene) => scene.id === sceneId
      ? { ...scene, videoPrompt: prompt }
      : scene));
    setVideoModal(null);
    void executeSceneJob(sceneId, "video", prompt, [], videoMode);
  };

  const runQueueCommand = async (
    operation: () => Promise<ProductionQueueSnapshot>,
    flushSession = true,
    sessionScenes: Scene[] = scenes,
  ) => {
    const commandSessionId = activeSessionIdRef.current;
    setQueueCommandError("");
    try {
      if (flushSession && sessionScenes.length > 0) {
        await window.flowx?.timeline.saveSession({
          scenes: sessionScenes,
          visualBible,
          styleReference,
          workflowMode,
          workflowSource,
        });
      }
      const snapshot = await operation();
      if (activeSessionIdRef.current !== commandSessionId) return;
      setQueueSnapshot(snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, snapshot));
    } catch (caught) {
      if (activeSessionIdRef.current !== commandSessionId) return;
      setQueueCommandError(errorMessage(caught));
    }
  };

  const refreshQueueSnapshot = async () => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    setQueueCommandError("");
    try {
      const snapshot = await bridge.getSnapshot(activeProjectId);
      setQueueSnapshot(snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, snapshot));
      setWorkflowNotice("Đã làm mới trạng thái workflow từ queue.");
    } catch (caught) {
      setQueueCommandError(errorMessage(caught));
    }
  };

  const regenerateQueuedScene = (
    sceneId: string,
    mediaType: SceneMediaType,
    promptOverride?: string,
  ) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    const nextScenes = typeof promptOverride === "string"
      ? scenes.map((scene) => scene.id === sceneId
        ? mediaType === "image"
          ? { ...scene, imagePrompt: promptOverride }
          : { ...scene, videoPrompt: promptOverride }
        : scene)
      : scenes;
    if (nextScenes !== scenes) setScenes(nextScenes);
    void runQueueCommand(
      () => bridge.regenerateScene(sceneId, mediaType, activeProjectId),
      true,
      nextScenes,
    );
  };

  const runOrRegenerateScene = (
    sceneId: string,
    mediaType: SceneMediaType,
    prompt: string,
  ) => {
    const scene = scenes.find((entry) => entry.id === sceneId);
    const hasOldResult = mediaType === "image"
      ? Boolean(scene?.imageResultPath || scene?.videoResultPath)
      : Boolean(scene?.videoResultPath);
    if (hasOldResult) {
      regenerateQueuedScene(sceneId, mediaType, prompt);
      return;
    }
    requestSceneJob(sceneId, mediaType, prompt);
  };

  const resumeQueueFromScene = (sceneId: string, mediaType: SceneMediaType) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(() => bridge.resumeFrom(sceneId, mediaType, activeProjectId));
  };

  const collectSubmittedVideos = () => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(() => bridge.generateAllVideos(activeProjectId, {
      onlyStatuses: ["video_submitted"],
      delivery: "download",
      videoProvider,
    }));
  };

  const repairPolicyPromptAndResume = async (
    sceneId: string,
    mediaType: SceneMediaType,
    selectedReason: PolicyReason,
    detail: string,
  ) => {
    const key = `${sceneId}:${mediaType}`;
    if (repairingPromptKey) return;
    const scene = scenes.find((entry) => entry.id === sceneId);
    const timeline = window.flowx?.timeline;
    const queue = window.flowx?.productionQueue;
    if (!scene || !timeline || !queue || !textWorkerConnected) {
      setSceneErrors((current) => ({
        ...current,
        [key]: !textWorkerConnected
          ? `${textProviderLabel} worker chưa kết nối`
          : "Bridge sửa prompt chưa sẵn sàng",
      }));
      return;
    }

    setRepairingPromptKey(key);
    setQueueCommandError("");
    try {
      const stopped = await queue.stopQueue(activeProjectId);
      setQueueSnapshot(stopped);
      await window.flowx?.sceneJobs.cancel().catch(() => false);

      const originalPrompt = mediaType === "image" ? scene.imagePrompt : scene.videoPrompt;
      const pairedPrompt = mediaType === "image" ? scene.videoPrompt : scene.imagePrompt;
      const queueError = queueSnapshot?.errors.find((item) =>
        item.sceneId === sceneId && item.mediaType === mediaType
      )?.message || "";
      const detectedError = sceneErrors[key] || queueError;
      const selectedOption = POLICY_REASON_OPTIONS.find((option) => option.value === selectedReason);
      const policyReasonText = selectedReason === "auto"
        ? detectedError || "Google Flow rejected this prompt under its safety policy."
        : `${selectedOption?.label || "Không rõ loại vi phạm"}: ${selectedOption?.description || ""}`;
      const normalizedDetail = detail.trim();
      const additionalDetail = normalizedDetail && (
        selectedReason !== "auto" || normalizedDetail !== detectedError
      )
        ? `Chi tiết hoặc thông báo Flow: ${normalizedDetail}`
        : "";
      const rewritten = await timeline.rewritePolicyPrompt({
        textProvider,
        sceneId,
        mediaType,
        prompt: originalPrompt,
        policyError: [policyReasonText, additionalDetail].filter(Boolean).join("\n"),
        timeStart: scene.timeStart,
        timeEnd: scene.timeEnd,
        pairedPrompt,
        visualBible,
      });

      const nextScenes = scenes.map((entry) => {
        if (entry.id !== sceneId) return entry;
        if (mediaType === "image") {
          return {
            ...entry,
            imagePrompt: rewritten.prompt,
            imageStatus: "pending" as const,
            imageResultPath: "",
            imageFlowAssetKey: "",
            imageApproved: false,
            videoStatus: "pending" as const,
            videoResultPath: "",
            videoApproved: false,
            usedCharacterTokens: parseCharacterTokens(`${rewritten.prompt}\n${entry.videoPrompt}`),
          };
        }
        return {
          ...entry,
          videoPrompt: rewritten.prompt,
          imageApproved: entry.imageResultPath ? true : entry.imageApproved,
          videoStatus: "pending" as const,
          videoResultPath: "",
          videoApproved: false,
          usedCharacterTokens: parseCharacterTokens(`${entry.imagePrompt}\n${rewritten.prompt}`),
        };
      });
      setScenes(nextScenes);
      await timeline.saveSession({
        scenes: nextScenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      setSceneErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      const resumed = await queue.resumeFrom(sceneId, mediaType, activeProjectId);
      setQueueSnapshot(resumed);
      setScenes((current) => applyQueueSnapshotToScenes(current, resumed));
      setPolicyRepairModal(null);
    } catch (caught) {
      setSceneErrors((current) => ({
        ...current,
        [key]: `Không thể tự sửa prompt: ${errorMessage(caught)}. Hàng đợi vẫn đang dừng.`,
      }));
    } finally {
      setRepairingPromptKey("");
    }
  };

  const openPolicyRepairModal = (sceneId: string, mediaType: SceneMediaType) => {
    const key = `${sceneId}:${mediaType}`;
    const queueError = queueSnapshot?.errors.find((item) =>
      item.sceneId === sceneId && item.mediaType === mediaType
    );
    const detectedError = sceneErrors[key] || queueError?.message || "";
    if (queueError?.category === "flow_policy_violation" || isDetectedPolicyError(detectedError)) {
      void repairPolicyPromptAndResume(sceneId, mediaType, "auto", detectedError);
      return;
    }
    setPolicyReason("other");
    setPolicyDetail("");
    setPolicyRepairModal({ sceneId, mediaType, detectedError: "" });
  };

  const approveQueuedScene = (sceneId: string, mediaType: SceneMediaType) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(
      () => bridge.approveScene(sceneId, mediaType, activeProjectId),
      true,
    );
  };

  const rejectQueuedScene = (sceneId: string, mediaType: SceneMediaType) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(
      () => bridge.rejectScene(sceneId, mediaType, activeProjectId),
      true,
    );
  };

  const startAutomaticImageVideoPipeline = () => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(async () => {
      await bridge.setApprovalPolicy(
        true,
        true,
        activeProjectId,
      );
      const snapshot = await bridge.generateAllImages(activeProjectId, { imageProvider });
      setWorkflowNotice("Bước sản xuất đã bắt đầu: app tự tạo ảnh, duyệt và dựng video theo thứ tự scene.");
      return snapshot;
    });
  };

  const startDirectVideoPipeline = () => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge) return;
    void runQueueCommand(async () => {
      await bridge.setApprovalPolicy(
        false,
        true,
        activeProjectId,
      );
      const snapshot = await bridge.generateAllVideos(activeProjectId, {
        onlyApprovedImages: false,
        videoMode: "text-to-video",
        delivery: workflowSource.directVideoDelivery || "download",
        videoProvider,
      });
      setWorkflowNotice(
        (workflowSource.directVideoDelivery || "download") === "submit-only"
          ? "Đã gửi prompt sang Google Flow. Video sẽ chưa hiện trong app cho đến khi chạy Thu thập video."
          : "Đã bắt đầu tạo video trực tiếp và tải file về app: prompt -> Thành phần -> 16:9 -> thời lượng theo scene.",
      );
      return snapshot;
    });
  };

  const startSelectedProductionPipeline = () => {
    if (isDirectScriptVideoWorkflow(workflowSource)) {
      startDirectVideoPipeline();
      return;
    }
    startAutomaticImageVideoPipeline();
  };

  const changeImageProvider = (provider: ImageGenerationProvider) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge || provider === imageProvider) return;
    void runQueueCommand(
      async () => {
        const snapshot = await bridge.setImageProvider(provider, activeProjectId);
        setWorkflowNotice(`Đã chọn ${IMAGE_PROVIDER_LABEL[provider]} làm nhà tạo ảnh.`);
        return snapshot;
      },
      false,
    );
  };

  const changeVideoProvider = (provider: VideoGenerationProvider) => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge || provider === videoProvider) return;
    void runQueueCommand(
      async () => {
        const snapshot = await bridge.setVideoProvider(provider, activeProjectId);
        setWorkflowNotice(`Đã chọn ${VIDEO_PROVIDER_LABEL[provider]} làm nhà tạo video.`);
        return snapshot;
      },
      false,
    );
  };

  const clearAllGeneratedMedia = async () => {
    const bridge = window.flowx?.productionQueue;
    if (!bridge || clearingGeneratedMedia || Boolean(clearingSceneId)) return;
    setClearingGeneratedMedia(true);
    setQueueCommandError("");
    setClearMediaNotice("");
    try {
      await window.flowx?.timeline.saveSession({
        scenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      const result = await bridge.clearGeneratedMedia(activeProjectId);
      setQueueSnapshot(result.snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, result.snapshot));
      setSceneErrors({});
      setThumbnails({});
      setImageModal(null);
      setVideoModal(null);
      settledSceneJobs.current.clear();
      loadedThumbnailPaths.current.clear();
      setClearMediaConfirmOpen(false);
      setClearMediaNotice(
        `Đã xóa ${result.deletedFiles} file trên máy trong ${result.deletedDirectories} thư mục; giữ nguyên ${result.retainedScenes} scene và toàn bộ câu lệnh. Nội dung trong thư viện của provider không bị xóa.`,
      );
    } catch (caught) {
      setQueueCommandError(errorMessage(caught));
    } finally {
      setClearingGeneratedMedia(false);
    }
  };

  const clearOneSceneMedia = async () => {
    const sceneId = clearSceneMediaTarget;
    const bridge = window.flowx?.productionQueue;
    if (!bridge || !sceneId || clearingSceneId || clearingGeneratedMedia) return;
    setClearingSceneId(sceneId);
    setQueueCommandError("");
    setClearMediaNotice("");
    try {
      await window.flowx?.timeline.saveSession({
        scenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      const result = await bridge.clearSceneMedia(sceneId, activeProjectId);
      setQueueSnapshot(result.snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, result.snapshot));
      setSceneErrors((current) => {
        const next = { ...current };
        delete next[`${sceneId}:image`];
        delete next[`${sceneId}:video`];
        return next;
      });
      setThumbnails((current) => {
        const next = { ...current };
        delete next[sceneId];
        return next;
      });
      settledSceneJobs.current.delete(`${sceneId}:image`);
      settledSceneJobs.current.delete(`${sceneId}:video`);
      loadedThumbnailPaths.current.clear();
      setImageModal((current) => current?.sceneId === sceneId ? null : current);
      setVideoModal((current) => current?.sceneId === sceneId ? null : current);
      setClearSceneMediaTarget(null);
      setClearMediaNotice(
        `Đã xóa ${result.deletedFiles} file và toàn bộ công việc của ${sceneId}; câu lệnh của cảnh vẫn được giữ nguyên.`,
      );
    } catch (caught) {
      setQueueCommandError(errorMessage(caught));
    } finally {
      setClearingSceneId("");
    }
  };

  const generate = async (handoff?: IntegratedWorkflowHandoff) => {
    const sourceInput = handoff?.workflowSource || workflowSource;
    const bibleInput = handoff?.visualBible || visualBible;
    const referenceInput = handoff ? handoff.styleReference : styleReference;
    const modeInput = handoff?.workflowMode || workflowMode;
    const automaticInput = modeInput === "automatic";
    const targetProjectId = handoff?.sessionId || activeProjectId;
    const scriptWorkflow = sourceInput.sourceKind === "script";
    const outputTarget: TimelineOutputTarget = scriptWorkflow
      ? sourceInput.outputTarget || "video"
      : "video";
    const videoSourceModeInput: TimelineVideoSourceMode = scriptWorkflow && outputTarget === "video"
      ? sourceInput.videoSourceMode || "direct"
      : "image-first";
    const importedVoiceAudio = isImportedVoiceAudioSource(sourceInput);
    const hasDeferredVoice = !importedVoiceAudio &&
      Boolean(sourceInput.narrationText?.trim() && sourceInput.voiceName?.trim());
    setError("");
    setWorkflowNotice("");
    if (!scriptWorkflow && !bibleInput.style.trim()) {
      setError("Phong cách đồ họa trong Visual Bible là bắt buộc. Hãy nhập hoặc chọn một phong cách đã lưu.");
      return;
    }
    if (scriptWorkflow) {
      if (!handoff && scriptFile && !validateFile(scriptFile, "File kịch bản", [".txt", ".md"])) return;
      if (!handoff && srtFile && !validateFile(srtFile, "File phụ đề", [".srt"])) return;
      if (!scriptFile && !sourceInput.scriptText.trim()) {
        setError("Hãy nhập hoặc tải một file kịch bản.");
        return;
      }
    } else if (automaticInput) {
      if (importedVoiceAudio) {
        if (!sourceInput.audioPath.trim()) { setError("Chế độ MP3 chưa có voice audio hợp lệ."); return; }
        if (!sourceInput.srtText.trim()) { setError("Voice audio MP3 cần file SRT đồng bộ để tạo timeline chính xác."); return; }
        if (!sourceInput.scriptText.trim() && !sourceInput.narrationText?.trim()) { setError("Voice audio MP3 chưa có transcript hoặc kịch bản để phân tích hình ảnh."); return; }
      } else {
        if (!sourceInput.narrationText?.trim()) { setError("Chế độ Tự động hoàn toàn chưa nhận được nội dung thoại từ Voice Studio."); return; }
        if (!sourceInput.voiceName?.trim()) { setError("Chế độ Tự động hoàn toàn chưa nhận được giọng đọc từ Voice Studio."); return; }
      }
    } else {
      if (!handoff && srtFile && !validateFile(srtFile, "File phụ đề", [".srt"])) return;
      if (!handoff && scriptFile && !validateFile(scriptFile, "File kịch bản", [".txt", ".md"])) return;
      if (!srtFile && !sourceInput.srtText.trim()) { setError("Hãy chọn file phụ đề SRT."); return; }
      if (!scriptFile && !sourceInput.scriptText.trim()) { setError("Hãy chọn file kịch bản."); return; }
    }
    if (!textWorkerConnected) {
      setError(`${textProviderLabel} worker chưa kết nối`);
      return;
    }
    if (!window.flowx?.timeline) {
      setError("Timeline bridge chưa sẵn sàng");
      return;
    }

    setRunning(true);
    setProgress(null);
    try {
      let preparedSource = sourceInput;
      if (!srtFile && !sourceInput.srtText.trim() && hasDeferredVoice) {
        const voice = window.flowx?.voice;
        if (!voice || !sourceInput.narrationText?.trim() || !sourceInput.voiceName?.trim()) {
          throw new Error("Cấu hình Voice chưa đầy đủ để bắt đầu workflow");
        }
        setWorkflowNotice("Bước 1/3 · Đang tạo Voice và SRT từ cấu hình đã lưu…");
        const generatedVoice = await voice.generate({
          provider: sourceInput.voiceProvider || "edge",
          projectId: targetProjectId,
          projectName: sessionNameDraft,
          narrationText: sourceInput.narrationText,
          narrationFileName: sourceInput.narrationFileName || "loi-thoai.txt",
          voice: sourceInput.voiceName,
          prosody: {
            rate: sourceInput.voiceRate ?? 0,
            pitch: sourceInput.voicePitch ?? 0,
            volume: sourceInput.voiceVolume ?? 0,
            pauseLevel: sourceInput.voicePauseLevel || "medium",
          },
          splitMode: sourceInput.voiceSplitMode || "paragraph",
          maxCharsPerChunk: sourceInput.voiceMaxCharsPerChunk || 3000,
          exportWordSrt: Boolean(sourceInput.voiceExportWordSrt),
        });
        preparedSource = {
          ...sourceInput,
          srtText: generatedVoice.srtText,
          srtFileName: generatedVoice.srtFileName,
          srtPath: generatedVoice.srtPath,
          audioPath: generatedVoice.audioPath,
          audioFileName: generatedVoice.audioFileName,
          audioSource: "generated",
          voiceProvider: sourceInput.voiceProvider || "edge",
          audioDurationSeconds: generatedVoice.durationSeconds,
          audioSizeBytes: 0,
          scriptText: sourceInput.scriptText.trim() || sourceInput.narrationText.trim(),
          scriptFileName: sourceInput.scriptFileName || sourceInput.narrationFileName || "loi-thoai.txt",
        };
        setWorkflowSource(preparedSource);
        await window.flowx.timeline.saveSession({
          scenes,
          visualBible: bibleInput,
          styleReference: referenceInput,
          workflowMode: modeInput,
          workflowSource: preparedSource,
        });
        setWorkflowNotice("Bước 2/3 · Voice và SRT đã hoàn thành. Đang chia Timeline và viết Prompt…");
      }
      const [loadedSrtText, scriptText, availableCharacters] = await Promise.all([
        !automaticInput && !handoff && srtFile ? srtFile.text() : Promise.resolve(preparedSource.srtText),
        !automaticInput && !handoff && scriptFile ? scriptFile.text() : Promise.resolve(preparedSource.scriptText),
        window.flowx?.characters.list() || Promise.resolve(characters),
      ]);
      let srtText = loadedSrtText;
      let timingOrigin = preparedSource.timingOrigin;
      if (scriptWorkflow) {
        const useUserSrt = Boolean(
          (!handoff && srtFile) ||
          (preparedSource.timingOrigin === "user_srt" && preparedSource.srtText.trim()),
        );
        if (!useUserSrt) {
          const timing = buildScriptTimingPlan(scriptText, preparedSource.pacing || "balanced");
          srtText = timing.srtText;
          timingOrigin = "script_estimated";
          setWorkflowNotice(
            `Đã lập timeline nội bộ gồm ${timing.cues.length} đoạn, thời lượng ước tính ${compactDuration(timing.durationSeconds)}. Đang tạo prompt…`,
          );
        } else {
          timingOrigin = "user_srt";
        }
      }
      const nextWorkflowSource: TimelineWorkflowSource = {
        ...preparedSource,
        sourceKind: scriptWorkflow ? "script" : "voice",
        outputTarget,
        videoSourceMode: videoSourceModeInput,
        pacing: preparedSource.pacing || "balanced",
        timingOrigin,
        srtText,
        scriptText,
        srtFileName: scriptWorkflow && timingOrigin === "script_estimated"
          ? "timeline-tu-kich-ban.srt"
          : (!automaticInput && !handoff ? srtFile?.name : "") || preparedSource.srtFileName || "timeline.srt",
        scriptFileName: (!automaticInput && !handoff ? scriptFile?.name : "") || preparedSource.scriptFileName || "kich-ban.txt",
      };
      setWorkflowSource(nextWorkflowSource);
      setCharacters(availableCharacters);
      const characterRoster = recurringCharacterRoster(
        scriptText,
        availableCharacters.filter((character) => character.isRecurring !== false || character.isMain),
        2,
      );
      const result = await window.flowx.timeline.generate({
        textProvider,
        outputTarget,
        videoSourceMode: videoSourceModeInput,
        srtText,
        scriptText,
        visualBible: bibleInput,
        characterRoster,
        styleReference: referenceInput,
      });
      const preparedScenes: Scene[] = result.scenes.map((scene) => {
        const detectedTokens = matchCharacterNames(
          `${scene.imagePrompt}\n${scene.videoPrompt}`,
          characterRoster,
        );
        const tokens = [...new Set([...scene.usedCharacterTokens, ...detectedTokens])].slice(0, 4);
        return {
          ...scene,
          usedCharacterTokens: tokens,
          characterPolicy: tokens.length > 0 ? "selected" : "none",
          assignedCharacterTokens: tokens,
        };
      });
      setScenes(preparedScenes);
      setVisualBible(result.visualBible);
      setStyleReference(referenceInput);
      setWorkflowMode(modeInput);
      setProgress(null);
      const saved = await window.flowx.timeline.saveSession({
        scenes: preparedScenes,
        visualBible: result.visualBible,
        styleReference: referenceInput,
        workflowMode: modeInput,
        workflowSource: nextWorkflowSource,
      });
      setSessions((current) => current.map((entry) => entry.id === saved.id
        ? {
          ...entry,
          name: saved.name,
          sceneCount: saved.scenes.length,
          savedAt: saved.savedAt,
          active: true,
          workflowMode: saved.workflowMode,
        }
        : { ...entry, active: false }));
      onWorkflowReady?.();

      const shouldStartMedia = modeInput === "automatic" ||
        (scriptWorkflow && outputTarget !== "prompts");
      if (shouldStartMedia) {
        const queue = window.flowx?.productionQueue;
        if (!queue) throw new Error("Production queue chưa sẵn sàng");
        const policyFlaggedScenes = preparedScenes.filter((scene) => scene.policyFlag);
        if (policyFlaggedScenes.length > 0) {
          setWorkflowNotice(
            `Timeline và prompt đã được lưu. Có ${policyFlaggedScenes.length} scene cần kiểm tra chính sách trước khi bắt đầu sản xuất.`,
          );
          return;
        }
        try {
          const generateVideo = outputTarget === "video";
          const directScriptVideo = scriptWorkflow && generateVideo && videoSourceModeInput === "direct";
          const snapshot = directScriptVideo
            ? await (async () => {
                await queue.setApprovalPolicy(false, true, targetProjectId);
                return queue.generateAllVideos(targetProjectId, {
                  onlyApprovedImages: false,
                  videoMode: "text-to-video",
                  delivery: preparedSource.directVideoDelivery || "download",
                  videoProvider,
                });
              })()
            : await (async () => {
                await queue.setApprovalPolicy(generateVideo, generateVideo, targetProjectId);
                return queue.generateAllImages(targetProjectId, { imageProvider });
              })();
          setQueueSnapshot(snapshot);
          setScenes((current) => applyQueueSnapshotToScenes(current, snapshot));
          setWorkflowNotice(directScriptVideo
            ? "Đã tạo timeline và prompt. Google Flow đang tạo video trực tiếp từ prompt, không cần ảnh khởi đầu."
            : generateVideo
            ? "Đã tạo timeline và prompt. App đang tự động sản xuất ảnh khởi đầu và video."
            : "Đã tạo timeline và prompt. Storyboard ảnh đang được đưa vào hàng đợi sản xuất.");
        } catch (queueError) {
          setQueueCommandError(errorMessage(queueError));
          setWorkflowNotice(imageProviderConnected && videoProviderConnected
            ? "Kịch bản cảnh và câu lệnh đã được lưu. Hàng đợi tự động chưa khởi động; có thể tiếp tục từ màn hình Sản xuất."
            : `Voice, SRT, kịch bản cảnh và câu lệnh đã được lưu. Hãy mở ${imageProviderLabel} và ${videoProviderLabel} để extension kết nối, sau đó tiếp tục tại màn hình Sản xuất.`);
        }
      } else {
        setWorkflowNotice(scriptWorkflow
          ? "Timeline và prompt đã hoàn tất. Bạn có thể kiểm tra, chỉnh sửa hoặc chọn sản xuất media sau."
          : "Timeline và prompt đã hoàn tất. Hãy kiểm tra rồi chạy tạo ảnh và video.");
      }
    } catch (caught) {
      const message = errorMessage(caught);
      if (!/STOPPED|generation stopped|đã dừng/i.test(message)) {
        setError(message);
      }
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (
      !sessionReady ||
      !integratedHandoff ||
      consumedHandoffIds.current.has(integratedHandoff.id)
    ) return;
    consumedHandoffIds.current.add(integratedHandoff.id);
    let active = true;
    const apply = async () => {
      try {
        const timeline = window.flowx?.timeline;
        if (!timeline) throw new Error("Timeline bridge chưa sẵn sàng");
        const session = activeSessionIdRef.current === integratedHandoff.sessionId
          ? await timeline.loadSession()
          : await timeline.selectSession(integratedHandoff.sessionId);
        if (!session) throw new Error("Không tìm thấy phiên vừa tạo voice.");
        if (!active) return;
        applySession(session);
        setSessions(await timeline.listSessions());
        onIntegratedHandoffConsumed?.();
        if (integratedHandoff.autoGenerateTimeline) {
          await generate({
            ...integratedHandoff,
            workflowMode: session.workflowMode,
            workflowSource: session.workflowSource,
            visualBible: session.visualBible,
            styleReference: session.styleReference,
          });
        } else {
          setWorkflowNotice("Voice và SRT đã được đưa vào dự án. Kiểm tra đầu vào rồi bấm Tạo timeline & prompt.");
        }
      } catch (caught) {
        if (active) setError(errorMessage(caught));
      }
    };
    void apply();
    return () => { active = false; };
  }, [sessionReady, integratedHandoff]);

  const cancel = async () => {
    try {
      await window.flowx?.timeline.cancel();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const canLeaveActiveSession = () => {
    if (!running) return true;
    setError("Phiên hiện tại đang sinh timeline/prompt. Hãy bấm “Dừng” trước khi chuyển hoặc tạo phiên khác.");
    return false;
  };

  const switchSession = async (id: string) => {
    const timeline = window.flowx?.timeline;
    if (!timeline || id === activeSessionId || switchingSession || clearingGeneratedMedia || Boolean(clearingSceneId)) return;
    if (!canLeaveActiveSession()) return;
    setSwitchingSession(true);
    setSessionReady(false);
    setError("");
    try {
      await timeline.saveSession({
        scenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      const selected = await timeline.selectSession(id);
      applySession(selected);
      setSessions(await timeline.listSessions());
      const snapshot = await window.flowx?.productionQueue.getSnapshot(selected.id);
      if (snapshot) setQueueSnapshot(snapshot);
      setSessionStatus("saved");
    } catch (caught) {
      setError(errorMessage(caught));
      setSessionStatus("error");
    } finally {
      setSessionReady(true);
      setSwitchingSession(false);
    }
  };

  const createSession = async () => {
    const timeline = window.flowx?.timeline;
    if (!timeline || switchingSession || clearingGeneratedMedia || Boolean(clearingSceneId)) return;
    if (!canLeaveActiveSession()) return;
    setSwitchingSession(true);
    setSessionReady(false);
    try {
      await timeline.saveSession({
        scenes,
        visualBible,
        styleReference,
        workflowMode,
        workflowSource,
      });
      const created = await timeline.createSession(`Phiên ${sessions.length + 1}`);
      applySession(created);
      setSessions(await timeline.listSessions());
      const snapshot = await window.flowx?.productionQueue.getSnapshot(created.id);
      if (snapshot) setQueueSnapshot(snapshot);
      setSessionStatus("saved");
    } catch (caught) {
      setError(errorMessage(caught));
      setSessionStatus("error");
    } finally {
      setSessionReady(true);
      setSwitchingSession(false);
    }
  };

  const renameActiveSession = async () => {
    const timeline = window.flowx?.timeline;
    const name = sessionNameDraft.trim();
    if (!timeline || !name || switchingSession || clearingGeneratedMedia || Boolean(clearingSceneId)) return;
    try {
      setSessions(await timeline.renameSession(activeSessionId, name));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const deleteActiveSession = async () => {
    const timeline = window.flowx?.timeline;
    if (!timeline || switchingSession || clearingGeneratedMedia || Boolean(clearingSceneId)) return;
    if (!canLeaveActiveSession()) return;
    const queueBusy = Boolean(
      queueSnapshot?.activeJobId ||
      (queueSnapshot?.activeJobs?.length || 0) > 0 ||
      queueSnapshot?.state === "running" ||
      queueSnapshot?.state === "paused",
    );
    if (queueBusy) {
      setError("Phiên hiện tại vẫn còn workflow đang chạy. Hãy dừng hàng đợi trước khi xóa phiên.");
      return;
    }
    setSwitchingSession(true);
    setSessionReady(false);
    try {
      const deleted = await timeline.deleteSession(activeSessionId);
      const next = deleted.activeSession || await timeline.createSession("Phiên 1");
      applySession(next);
      setSessions(await timeline.listSessions());
      const snapshot = await window.flowx?.productionQueue.getSnapshot(next.id);
      if (snapshot) setQueueSnapshot(snapshot);
      setResetConfirmOpen(false);
      setSessionStatus("saved");
    } catch (caught) {
      setError(errorMessage(caught));
      setSessionStatus("error");
    } finally {
      setSessionReady(true);
      setSwitchingSession(false);
    }
  };

  const saveStylePreset = (name: string) => {
    setStylePresetError("");
    void window.flowx?.visualStyles.save({ name, style: visualBible.style }).then(
      setStylePresets,
      (caught) => setStylePresetError(errorMessage(caught)),
    );
  };

  const deleteStylePreset = (id: string) => {
    setStylePresetError("");
    void window.flowx?.visualStyles.remove(id).then(
      setStylePresets,
      (caught) => setStylePresetError(errorMessage(caught)),
    );
  };

  const scriptWorkflow = workflowSource.sourceKind === "script";
  const scriptOutputTarget = workflowSource.outputTarget || (scriptWorkflow ? "video" : "prompts");
  const scriptVideoSourceMode: TimelineVideoSourceMode = workflowSource.videoSourceMode || "direct";
  const scriptDirectVideo = scriptWorkflow && scriptOutputTarget === "video" && scriptVideoSourceMode === "direct";
  const activePromptFileVideoMode: PromptFileVideoMode = workflowSource.promptFileVideoMode || promptFileVideoMode;
  const scriptPacing = workflowSource.pacing || "balanced";
  const promptFilePathCandidate = scriptWorkflow
    ? detectLocalPromptFilePath(workflowSource.scriptText)
    : null;
  const promptFileReview = useMemo(() => {
    if (!scriptWorkflow || promptFilePathCandidate || !workflowSource.scriptText.trim()) return null;
    return analyzePromptFileText(workflowSource.scriptText, {
      sourceName: workflowSource.scriptFileName,
      sourcePath: workflowSource.scriptPath,
    });
  }, [
    promptFilePathCandidate,
    scriptWorkflow,
    workflowSource.scriptFileName,
    workflowSource.scriptPath,
    workflowSource.scriptText,
  ]);
  const promptFileBlockingIssues = promptFileReview?.issues.filter((issue) => issue.severity === "blocking") || [];
  const promptFileImportReady = Boolean(promptFileReview && promptFileBlockingIssues.length === 0);
  const promptFileModeScenes = promptFileReview
    ? promptFileScenesForMode(promptFileReview, activePromptFileVideoMode)
    : null;
  const promptFileTimelineApplied = Boolean(
    promptFileReview &&
      promptFileModeScenes &&
      scenesMatchPromptFileImport(scenes, promptFileReview) &&
      scenes.length === promptFileModeScenes.length &&
      scenes.every((scene, index) => {
        const expected = promptFileModeScenes[index];
        return Boolean(expected) &&
          scene.imagePrompt === expected.imagePrompt &&
          scene.chainRole === expected.chainRole &&
          scene.startingFrameSource === expected.startingFrameSource;
      }),
  );
  const scriptTimingPreview = useMemo(() => {
    if (!scriptWorkflow || promptFileReview || !workflowSource.scriptText.trim()) return null;
    try {
      return buildScriptTimingPlan(workflowSource.scriptText, scriptPacing);
    } catch {
      return null;
    }
  }, [promptFileReview, scriptPacing, scriptWorkflow, workflowSource.scriptText]);

  const changePromptFileVideoMode = (mode: PromptFileVideoMode) => {
    setPromptFileVideoMode(mode);
    setWorkflowSource((current) => ({
      ...current,
      outputTarget: "video",
      videoSourceMode: mode === "connected-chain" ? "image-first" : "direct",
      directVideoDelivery: mode === "direct-submit" ? "submit-only" : "download",
      promptFileVideoMode: mode,
    }));
  };

  const loadPromptFileFromPath = async () => {
    const path = promptFilePathCandidate;
    const bridge = window.flowx?.timeline;
    if (!path || !bridge || promptFilePathLoading) return;
    setPromptFilePathLoading(true);
    setError("");
    setWorkflowNotice("");
    try {
      const imported = await bridge.importPromptFile(path);
      setScriptFile(null);
      setSrtFile(null);
      setPromptFileVideoMode(imported.workflowSource.promptFileVideoMode || "direct-download");
      setWorkflowSource(imported.workflowSource);
      setWorkflowNotice(
        `Đã đọc ${imported.summary.clipCount} clip từ ${imported.sourceName}. Kiểm tra review rồi import vào timeline.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPromptFilePathLoading(false);
    }
  };

  const applyPromptFileImport = async (
    startVideo = false,
    mode: PromptFileVideoMode = activePromptFileVideoMode,
  ) => {
    if (!promptFileReview) return;
    if (promptFileBlockingIssues.length > 0) {
      setError(promptFileBlockingIssues[0]?.message || "Prompt file còn lỗi cần sửa trước khi import.");
      return;
    }
    if (running || queueSnapshot?.state === "running" || queueSnapshot?.state === "paused") {
      setError("Hãy dừng quá trình đang chạy trước khi thay timeline bằng prompt file.");
      return;
    }
    const timeline = window.flowx?.timeline;
    if (!timeline) {
      setError("Timeline bridge chưa sẵn sàng");
      return;
    }

    const nextScenes = promptFileScenesForMode(promptFileReview, mode);
    const nextWorkflowSource: TimelineWorkflowSource = promptFileWorkflowSourceForMode(promptFileReview, mode);
    const directPromptVideo = mode !== "connected-chain";
    setError("");
    setWorkflowNotice("");
    setScenes(nextScenes);
    setWorkflowSource(nextWorkflowSource);
    setPromptFileVideoMode(mode);
    setWorkflowMode("two_step");
    setProgress(null);
    setSceneErrors({});
    setThumbnails({});
    settledSceneJobs.current.clear();
    loadedThumbnailPaths.current.clear();
    if (nextScenes[0]) selectScene(nextScenes[0].id);

    try {
      const saved = await timeline.saveSession({
        scenes: nextScenes,
        visualBible,
        styleReference,
        workflowMode: "two_step",
        workflowSource: nextWorkflowSource,
      });
      setSessions((current) => current.map((entry) => entry.id === saved.id
        ? {
          ...entry,
          name: saved.name,
          sceneCount: saved.scenes.length,
          savedAt: saved.savedAt,
          active: true,
          workflowMode: saved.workflowMode,
        }
        : { ...entry, active: false }));
      onWorkflowReady?.();

      if (!startVideo) {
        setWorkflowNotice(
          `Đã import ${nextScenes.length} clip làm timeline có sẵn. CLIP metadata đã được tách khỏi prompt gửi sang video.`,
        );
        return;
      }
      const queue = window.flowx?.productionQueue;
      if (!queue) throw new Error("Production queue chưa sẵn sàng");
      const snapshot = directPromptVideo
        ? await (async () => {
          await queue.setApprovalPolicy(false, true, activeProjectId);
          return queue.generateAllVideos(activeProjectId, {
            onlyApprovedImages: false,
            videoMode: "text-to-video",
            delivery: mode === "direct-submit" ? "submit-only" : "download",
            videoProvider,
          });
        })()
        : await (async () => {
          await queue.setVideoProvider(videoProvider, activeProjectId);
          await queue.setApprovalPolicy(true, true, activeProjectId);
          return queue.generateAllImages(activeProjectId, { imageProvider });
        })();
      setQueueSnapshot(snapshot);
      setScenes((current) => applyQueueSnapshotToScenes(current, snapshot));
      const promptFileRunNotice = mode === "direct-submit"
        ? `Đã import ${nextScenes.length} clip và gửi prompt sang Google Flow. Dùng Thu thập video để tải file về app khi Flow render xong.`
        : mode === "connected-chain"
          ? `Đã import ${nextScenes.length} clip và bắt đầu Connected Chain: tạo frame mở đầu, video, trích frame cuối rồi nối scene sau.`
          : `Đã import ${nextScenes.length} clip và bắt đầu tạo, tải video trực tiếp từ prompt file.`;
      setWorkflowNotice(promptFileRunNotice);
    } catch (caught) {
      setQueueCommandError(errorMessage(caught));
    }
  };

  const selectScriptFile = (file: File | null) => {
    setScriptFile(file);
    if (!file) return;
    void file.text().then(
      (text) => setWorkflowSource((current) => ({
        ...current,
        sourceKind: "script",
        scriptText: text,
        scriptFileName: file.name,
        scriptPath: "",
        timingOrigin: current.timingOrigin === "user_srt" ? "user_srt" : "script_estimated",
      })),
      (caught) => setError(errorMessage(caught)),
    );
  };
  const selectScriptSrtFile = (file: File | null) => {
    setSrtFile(file);
    setWorkflowSource((current) => ({
      ...current,
      timingOrigin: file ? "user_srt" : "script_estimated",
      srtText: file ? current.srtText : "",
      srtFileName: file?.name || "",
    }));
  };
  const importedVoiceAudio = isImportedVoiceAudioSource(workflowSource);
  const workflowVoiceProvider = importedVoiceAudio
    ? "imported"
    : workflowSource.voiceProvider || "edge";
  const workflowVoiceLabel = workflowSource.voiceName
    ? `${VOICE_PROVIDER_LABEL[workflowVoiceProvider]} - ${workflowSource.voiceName}`
    : "";
  const hasDeferredVoice = !importedVoiceAudio &&
    Boolean(workflowSource.narrationText?.trim() && workflowSource.voiceName?.trim());
  const hasVoiceStudioSource = hasDeferredVoice || Boolean(
    importedVoiceAudio &&
    workflowSource.audioPath.trim() &&
    workflowSource.srtText.trim(),
  );
  const automaticMode = workflowMode === "automatic";
  const hasSrtInput = Boolean(srtFile || workflowSource.srtText.trim() || hasDeferredVoice);
  const hasScriptInput = Boolean(scriptFile || workflowSource.scriptText.trim() || workflowSource.narrationText?.trim());
  const startInputBlockers = (scriptWorkflow
    ? [
      !hasScriptInput ? "kịch bản" : "",
    ]
    : automaticMode
    ? importedVoiceAudio
      ? [
        !workflowSource.audioPath.trim() ? "voice audio MP3" : "",
        !workflowSource.srtText.trim() ? "SRT đồng bộ với MP3" : "",
        !hasScriptInput ? "transcript hoặc kịch bản" : "",
        !visualBible.style.trim() ? "phong cách Visual Bible" : "",
      ]
      : [
        !workflowSource.narrationText?.trim() ? "nội dung thoại từ Voice Studio" : "",
        !workflowSource.voiceName?.trim() ? "giọng đọc" : "",
        !visualBible.style.trim() ? "phong cách Visual Bible" : "",
      ]
    : [
    !hasSrtInput ? "file SRT" : "",
    !hasScriptInput ? "kịch bản" : "",
    !visualBible.style.trim() ? "phong cách Visual Bible" : "",
  ]).filter(Boolean);
  const scriptNeedsImages = scriptWorkflow && (
    scriptOutputTarget === "images" ||
    (scriptOutputTarget === "video" && !scriptDirectVideo)
  );
  const textWorkerRequired = !scriptWorkflow ||
    (!promptFilePathCandidate && !promptFileImportReady && !promptFileTimelineApplied);
  const startConnectionWarnings = [
    textWorkerRequired && !textWorkerConnected ? `${textProviderLabel} chưa kết nối` : "",
    (workflowMode === "automatic" || scriptNeedsImages) && !imageProviderConnected
      ? `${imageProviderLabel} chưa kết nối; công việc tạo ảnh sẽ chờ`
      : "",
    (workflowMode === "automatic" || (scriptWorkflow && scriptOutputTarget === "video")) && !videoProviderConnected
      ? `${videoProviderLabel} chưa kết nối; công việc tạo video sẽ chờ`
      : "",
  ].filter(Boolean);
  const completedVideoCount = scenes.filter((scene) => scene.videoStatus === "done").length;
  const productionStarted = Boolean(
    queueSnapshot?.activeJobId ||
    queueSnapshot?.queuedJobs ||
    scenes.some((scene) => scene.imageStatus !== "pending" || scene.videoStatus !== "pending"),
  );
  const workflowBusy = running || queueSnapshot?.state === "running";
  const sessionChangeLocked = Boolean(running);
  const sessionDeleteLocked = Boolean(
    running ||
    queueSnapshot?.activeJobId ||
    (queueSnapshot?.activeJobs?.length || 0) > 0 ||
    queueSnapshot?.state === "running" ||
    queueSnapshot?.state === "paused",
  );
  const workflowDashboardActions: WorkflowDashboardActions = {
    onStart: startSelectedProductionPipeline,
    onGenerateImages: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.generateAllImages(activeProjectId, { imageProvider }));
    },
    onGenerateVideos: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.generateAllVideos(
        activeProjectId,
        { onlyApprovedImages: true, delivery: "download", videoProvider },
      ));
    },
    onGenerateDirectVideos: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.generateAllVideos(
        activeProjectId,
        { onlyApprovedImages: false, videoMode: "text-to-video", delivery: workflowSource.directVideoDelivery || "download", videoProvider },
      ));
    },
    onCollectSubmittedVideos: collectSubmittedVideos,
    onPause: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.pauseQueue(activeProjectId), false);
    },
    onResume: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.resumeQueue(activeProjectId), false);
    },
    onStop: () => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.stopQueue(activeProjectId), false);
    },
    onRetryErrors: () => {
      const bridge = window.flowx?.productionQueue;
      const sceneIds = [...new Set(queueSnapshot?.errors.map((item) => item.sceneId) || [])];
      if (!bridge || !sceneIds.length) return;
      if (scriptDirectVideo) {
        void runQueueCommand(() => bridge.generateAllVideos(
          activeProjectId,
          { onlyApprovedImages: false, videoMode: "text-to-video", delivery: workflowSource.directVideoDelivery || "download", videoProvider },
        ));
        return;
      }
      void runQueueCommand(() => bridge.retryFailed(sceneIds, activeProjectId));
    },
    onClearResults: () => setClearMediaConfirmOpen(true),
    onBuildVideo: onBuildVideo || (() => undefined),
    onRefresh: () => void refreshQueueSnapshot(),
    onAutoApproveChange: (enabled) => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.setApprovalPolicy(enabled, queueSnapshot?.autoApproveVideos || false, activeProjectId), false);
    },
    onVideoAutoApproveChange: (enabled) => {
      const bridge = window.flowx?.productionQueue;
      if (bridge) void runQueueCommand(() => bridge.setApprovalPolicy(queueSnapshot?.autoApproveImages || false, enabled, activeProjectId), false);
    },
    onImageProviderChange: changeImageProvider,
    onVideoProviderChange: changeVideoProvider,
    onSelect: selectScene,
    onPromptChange: updatePrompt,
    onSave: () => void saveCurrentSession(),
    onRun: (sceneId, mediaType, prompt) => {
      const selectedScene = scenes.find((entry) => entry.id === sceneId);
      if (mediaType === "video" && selectedScene?.chainRole === "continue" && !scriptDirectVideo) {
        resumeQueueFromScene(sceneId, "video");
        return;
      }
      runOrRegenerateScene(sceneId, mediaType, prompt);
    },
    onRegenerate: regenerateQueuedScene,
    onApprove: approveQueuedScene,
    onReject: (sceneId, mediaType, reason) => {
      setWorkflowNotice(`Đã ghi nhận lý do từ chối Scene ${scenes.find((entry) => entry.id === sceneId)?.order || sceneId}: ${reason}`);
      rejectQueuedScene(sceneId, mediaType);
    },
    onRepairPolicy: openPolicyRepairModal,
    onResumeFrom: resumeQueueFromScene,
    onClear: setClearSceneMediaTarget,
    onOpenFolder: () => void window.flowx?.system.openOutput(activeProjectId),
  };
  const primaryActionDisabled = running ||
    queueSnapshot?.state === "running" ||
    promptFilePathLoading ||
    startInputBlockers.length > 0 ||
    Boolean(promptFileReview && promptFileBlockingIssues.length > 0);
  const primaryActionLabel = promptFilePathCandidate
    ? "Đọc prompt file"
    : promptFileImportReady && !promptFileTimelineApplied
      ? activePromptFileVideoMode === "connected-chain"
        ? "Import & chạy Connected Chain"
        : activePromptFileVideoMode === "direct-submit"
          ? "Import & gửi prompt"
          : "Import & tạo, tải video"
      : promptFileTimelineApplied
        ? activePromptFileVideoMode === "connected-chain"
          ? "Chạy Connected Chain"
          : activePromptFileVideoMode === "direct-submit"
            ? "Gửi prompt sang Flow"
            : "Tạo & tải video"
        : workflowMode === "automatic"
          ? "Bắt đầu toàn bộ quy trình"
          : scriptWorkflow
            ? scriptOutputTarget === "prompts"
              ? "Tạo timeline & prompt"
              : scriptOutputTarget === "images"
                ? "Tạo prompt & storyboard"
                : scriptDirectVideo ? "Tạo video trực tiếp" : "Tạo video từ kịch bản"
            : "Bắt đầu tạo kịch bản cảnh";
  const runPrimaryAction = () => {
    if (promptFilePathCandidate) {
      void loadPromptFileFromPath();
      return;
    }
    if (promptFileImportReady && !promptFileTimelineApplied) {
      void applyPromptFileImport(true);
      return;
    }
    if (promptFileTimelineApplied) {
      startSelectedProductionPipeline();
      return;
    }
    void generate();
  };

  return (
    <section className="timeline-import" ref={timelineRootRef}>
      <header className="section-header">
        <div>
          <p className="eyebrow">Dựng video</p>
          <h2>{scriptWorkflow ? "Kịch bản → prompt, storyboard hoặc video" : hasVoiceStudioSource ? "Kiểm tra thiết lập → bắt đầu toàn bộ quy trình" : "SRT + kịch bản → timeline và prompt"}</h2>
        </div>
        <div className="timeline-readiness">
          <div className={`chat-readiness ${textWorkerConnected ? "is-ready" : ""}`}>
            <span aria-hidden="true" />
            {textWorkerConnected
              ? `${textProviderLabel} đã kết nối`
              : `${textProviderLabel} chưa kết nối`}
          </div>
          <div className={`chat-readiness ${imageProviderConnected ? "is-ready" : ""}`}>
            <span aria-hidden="true" />
            {imageProviderConnected
              ? `${imageProviderLabel} đã kết nối`
              : `${imageProviderLabel} chưa kết nối`}
          </div>
          <div className={`chat-readiness ${videoProviderConnected ? "is-ready" : ""}`}>
            <span aria-hidden="true" />
            {videoProviderConnected
              ? `${videoProviderLabel} đã kết nối`
              : `${videoProviderLabel} chưa kết nối`}
          </div>
        </div>
      </header>

      {scenes.length === 0 && (
        <nav className="kc-start-stepper" aria-label="Tiến trình thiết lập workflow">
          <div className={`kc-start-step ${scriptWorkflow && !hasScriptInput ? "is-active" : "is-done"}`}><span>{scriptWorkflow && !hasScriptInput ? "01" : <Check size={14} />}</span><div><strong>{scriptWorkflow ? "01 Kịch bản" : "01 Voice audio & nội dung"}</strong><small>{scriptWorkflow ? hasScriptInput ? "Đã nhập" : "Đang chuẩn bị" : "Đã hoàn thành"}</small></div><i /></div>
          <div className={`kc-start-step ${scriptWorkflow && !hasScriptInput ? "" : "is-done"}`}><span>{scriptWorkflow && !hasScriptInput ? "02" : <Check size={14} />}</span><div><strong>{scriptWorkflow ? "02 Phân tích tự động" : "02 Nhân vật"}</strong><small>{scriptWorkflow ? "Timeline, nhân vật và phong cách" : characters.length ? "Đã hoàn thành" : "Không sử dụng"}</small></div><i /></div>
          <div className={`kc-start-step ${scriptWorkflow && !hasScriptInput ? "" : "is-done"}`}><span>{scriptWorkflow && !hasScriptInput ? "03" : <Check size={14} />}</span><div><strong>{scriptWorkflow ? "03 Mục tiêu đầu ra" : "03 Visual Bible"}</strong><small>{scriptWorkflow ? scriptOutputTarget === "video" ? scriptDirectVideo ? "Video trực tiếp" : "Video hoàn chỉnh" : scriptOutputTarget === "images" ? "Storyboard ảnh" : "Chỉ tạo prompt" : "Đã hoàn thành"}</small></div><i /></div>
          <div className="kc-start-step is-active"><span>04</span><div><strong>Bắt đầu workflow</strong><small>Kiểm tra và bắt đầu</small></div></div>
        </nav>
      )}

      <section className="workspace-session-bar" aria-label="Quản lý phiên làm việc">
        <label className="field workspace-session-select">
          <span>Phiên đang mở</span>
          <select
            value={activeSessionId}
            disabled={switchingSession || sessionChangeLocked || clearingGeneratedMedia || Boolean(clearingSceneId)}
            onChange={(event) => void switchSession(event.target.value)}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} · {session.sceneCount} scene
              </option>
            ))}
          </select>
        </label>
        <label className="field workspace-session-name">
          <span>Tên phiên</span>
          <input
            value={sessionNameDraft}
            maxLength={100}
            disabled={switchingSession || clearingGeneratedMedia || Boolean(clearingSceneId)}
            onChange={(event) => setSessionNameDraft(event.target.value)}
            onBlur={() => void renameActiveSession()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void renameActiveSession();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <div className="workspace-session-actions">
          <button className="button secondary compact" type="button" disabled={switchingSession || sessionChangeLocked || clearingGeneratedMedia || Boolean(clearingSceneId)} onClick={() => void createSession()}>
            <FolderPlus size={15} /> Phiên mới
          </button>
          <button className="icon-button" type="button" title={sessionDeleteLocked ? "Hãy dừng phiên trước khi xóa" : "Xóa phiên đang mở"} disabled={switchingSession || sessionDeleteLocked || clearingGeneratedMedia || Boolean(clearingSceneId)} onClick={() => setResetConfirmOpen(true)}>
            <Trash2 size={16} />
          </button>
        </div>
        {sessionChangeLocked && (
          <div className="workspace-session-lock" role="status">
            <ShieldCheck size={14} /> Phiên đang sinh timeline/prompt nên tạm khóa chuyển phiên.
          </div>
        )}
      </section>

      {running && scenes.length === 0 && (
        <section className="workflow-preparing-dashboard" aria-live="polite" aria-label="Đang chuẩn bị quản lý scene">
          <header>
            <div><LoaderCircle className="spin" size={21} /><div><p className="eyebrow">ĐANG TẠO DỮ LIỆU SCENE</p><h3>Đang chuẩn bị giao diện quản lý scene</h3></div></div>
            <div className="workflow-preparing-status"><span>{progress?.message || workflowNotice || "ChatGPT đang chia timeline và viết prompt…"}</span><button className="button danger compact" type="button" onClick={() => void cancel()}><Square size={13} /> Dừng</button></div>
          </header>
          <div className="workflow-preparing-steps">
            <article className="is-done"><Check size={15} /><div><strong>Voice, SRT và dữ liệu đầu vào</strong><small>Đã khóa và sẵn sàng</small></div></article>
            <i />
            <article className="is-active"><LoaderCircle className="spin" size={15} /><div><strong>Timeline và Prompt</strong><small>Đang phân tích nội dung</small></div></article>
            <i />
            <article><Clapperboard size={15} /><div><strong>Quản lý scene</strong><small>Sẽ tự mở ngay khi có kết quả</small></div></article>
          </div>
          <div className="workflow-preparing-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
          <p>Không cần nhập lại dữ liệu. Bạn có thể theo dõi tiến trình tại đây; danh sách scene sẽ xuất hiện ngay khi kịch bản cảnh hoàn tất.</p>
        </section>
      )}

      {scenes.length > 0 && (
        <WorkflowDashboard sessionName={sessionNameDraft} scenes={scenes} snapshot={queueSnapshot} thumbnails={thumbnails} characters={characters} selectedSceneId={selectedSceneId} videoSourceMode={scriptDirectVideo ? "direct" : "image-first"} imageConnected={imageProviderConnected} videoConnected={videoProviderConnected} imageProviderLabel={imageProviderLabel} videoProviderLabel={videoProviderLabel} busy={workflowBusy || clearingGeneratedMedia || Boolean(clearingSceneId)} actions={workflowDashboardActions} />
      )}

      <section className="video-workflow-panel is-locked-mode" aria-label="Quy trình của phiên">
        <div className="video-workflow-heading">
          <div>
            <p className="eyebrow">Quy trình đã chọn</p>
            <strong>{workflowMode === "automatic" ? "Đồng bộ thoại" : scriptWorkflow ? "Kịch bản → Media" : "Quy trình nâng cao"} · {sessionNameDraft}</strong>
          </div>
          <span className="workflow-save-hint">Chế độ được khóa từ lúc tạo phiên để tránh thay đổi nhầm</span>
        </div>
        <div className="workflow-step-strip" aria-label="Tiến trình dựng video">
          <div className={scenes.length > 0 ? "is-complete" : running ? "is-active" : "is-active"}>
            <span>1</span>
            <p><strong>{scriptWorkflow ? "Kịch bản" : hasVoiceStudioSource ? "Voice & SRT" : "Nguồn SRT"}</strong><small>{scriptWorkflow ? "Tự lập timeline; SRT chỉ là tùy chọn nâng cao" : importedVoiceAudio ? "Dùng trực tiếp MP3 và SRT đã kiểm tra" : hasDeferredVoice ? "Tạo audio và SRT từ cấu hình Voice Studio" : "Dùng file SRT và kịch bản đã chọn"}</small></p>
          </div>
          <i aria-hidden="true" />
          <div className={scenes.length > 0 ? "is-complete" : running ? "is-active" : ""}>
            <span>2</span>
            <p><strong>Timeline & prompt</strong><small>{promptFileImportReady || promptFileTimelineApplied ? "Dùng timeline clip có sẵn từ prompt file" : "ChatGPT chia scene và viết prompt nội dung"}</small></p>
          </div>
          <i aria-hidden="true" />
          <div className={completedVideoCount === scenes.length && scenes.length > 0
            ? "is-complete"
            : productionStarted
              ? "is-active"
              : ""}>
            <span>3</span>
            <p><strong>{scriptWorkflow && scriptOutputTarget === "prompts" ? "Bàn giao prompt" : scriptWorkflow && scriptOutputTarget === "images" ? "Storyboard ảnh" : "Sản xuất video"}</strong><small>{scriptWorkflow && scriptOutputTarget === "prompts" ? "Dừng sau khi tạo prompt để kiểm tra" : scriptWorkflow && scriptOutputTarget === "images" ? `${imageProviderLabel} tạo một ảnh cho từng cảnh` : scriptDirectVideo ? `${videoProviderLabel} tạo video trực tiếp từ prompt` : `${imageProviderLabel} tạo ảnh; ${videoProviderLabel} tạo frame nối tiếp và video`}</small></p>
          </div>
        </div>
      </section>

      {automaticMode ? (
        <section className="workflow-source-review" aria-label="Thiết lập sẵn sàng để bắt đầu">
          <header><div><p className="eyebrow">Kiểm tra trước khi chạy</p><h3>{startInputBlockers.length ? "Cần hoàn tất dữ liệu từ các bước trước" : "Đã nhận đủ dữ liệu từ các bước trước"}</h3></div><span className={startInputBlockers.length ? "is-blocked" : ""}>{startInputBlockers.length ? <CircleAlert size={14} /> : <Check size={14} />} {startInputBlockers.length ? "Thiếu dữ liệu" : "Sẵn sàng"}</span></header>
          <div>
            <article><FileText size={17} /><p><strong>Nội dung thoại</strong><span>{workflowSource.narrationText?.trim() ? workflowSource.narrationFileName || `${workflowSource.narrationText.trim().length.toLocaleString("vi-VN")} ký tự đã nhập` : "Chưa nhận dữ liệu từ Voice Studio"}</span></p></article>
            <article><Play size={17} /><p><strong>{importedVoiceAudio ? "Voice audio" : "Giọng đọc"}</strong><span>{importedVoiceAudio ? workflowSource.audioFileName || "Chưa chọn MP3" : workflowVoiceLabel || "Chưa chọn giọng đọc"}</span></p></article>
            <article><ShieldCheck size={17} /><p><strong>Nhân vật</strong><span>{characters.length > 0 ? `${characters.length} nhân vật trong thư viện` : "Không sử dụng nhân vật"}</span></p></article>
            <article><Sparkles size={17} /><p><strong>Phong cách đồ họa</strong><span>{visualBible.style.trim() ? "Đã khóa trong Visual Bible" : "Chưa thiết lập"}</span></p></article>
          </div>
          <small>Chế độ Tự động hoàn toàn không yêu cầu tải SRT hoặc kịch bản tại bước này. Khi bấm Bắt đầu, app tạo Voice + SRT, dùng nội dung thoại làm nguồn phân tích hình ảnh nếu chưa có kịch bản riêng, sau đó chia timeline và chạy các provider ảnh/video đã chọn.</small>
        </section>
      ) : scriptWorkflow ? (
        <section className="script-media-source" aria-label="Kịch bản và mục tiêu đầu ra">
          <header className="script-media-heading">
            <div>
              <p className="eyebrow">Kịch bản → Media</p>
              <h3>Nhập một kịch bản, phần còn lại được chuẩn bị tự động</h3>
              <p>Hệ thống tự chia nội dung thành cảnh, ước tính thời gian và tạo Visual Bible nếu bạn chưa thiết lập.</p>
            </div>
            <span className={hasScriptInput ? "is-ready" : "is-missing"}>
              {hasScriptInput ? <Check size={14} /> : <CircleAlert size={14} />}
              {hasScriptInput ? "Đã có kịch bản" : "Cần kịch bản"}
            </span>
          </header>

          <div className="script-editor-shell">
            <div className="script-editor-toolbar">
              <div>
                <strong>Nội dung kịch bản</strong>
                <small>Hỗ trợ văn bản thuần, Markdown, tiêu đề cảnh và hội thoại.</small>
              </div>
              <FilePicker
                id="timeline-script-file"
                label="Tải .txt hoặc .md"
                accept=".txt,.md,text/plain,text/markdown"
                file={scriptFile}
                savedName={workflowSource.scriptFileName}
                onChange={selectScriptFile}
              />
            </div>
            <textarea
              className="script-media-textarea"
              aria-label="Nội dung kịch bản"
              placeholder="Dán toàn bộ kịch bản tại đây…"
              value={workflowSource.scriptText}
              onChange={(event) => setWorkflowSource((current) => ({
                ...current,
                sourceKind: "script",
                scriptText: event.target.value,
                scriptFileName: current.scriptFileName || "kich-ban-da-dan.txt",
                scriptPath: "",
                timingOrigin: current.timingOrigin === "user_srt" ? "user_srt" : "script_estimated",
              }))}
            />
            <div className="script-editor-stats">
              <span>{workflowSource.scriptText.length.toLocaleString("vi-VN")} ký tự</span>
              <span>{scriptTimingPreview?.wordCount.toLocaleString("vi-VN") || 0} từ</span>
              <span>{promptFileReview ? `${promptFileReview.summary.clipCount} clip có sẵn · ${compactDuration(promptFileReview.summary.totalDurationSeconds)}` : scriptTimingPreview ? `${scriptTimingPreview.cues.length} đoạn · khoảng ${compactDuration(scriptTimingPreview.durationSeconds)}` : "Timeline sẽ được ước tính tự động"}</span>
            </div>
          </div>

          <PromptFileReviewCard
            pathCandidate={promptFilePathCandidate}
            review={promptFileReview}
            loadingPath={promptFilePathLoading}
            disabled={running || queueSnapshot?.state === "running" || queueSnapshot?.state === "paused"}
            timelineApplied={promptFileTimelineApplied}
            videoMode={activePromptFileVideoMode}
            onLoadPath={() => void loadPromptFileFromPath()}
            onVideoModeChange={changePromptFileVideoMode}
            onImport={() => void applyPromptFileImport(false, activePromptFileVideoMode)}
            onImportAndRun={() => void applyPromptFileImport(true, activePromptFileVideoMode)}
          />

          <fieldset className="script-output-fieldset">
            <legend>Muốn nhận kết quả nào?</legend>
            <div className="script-output-options">
              {SCRIPT_OUTPUT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={scriptOutputTarget === option.value ? "is-selected" : ""}
                  type="button"
                  aria-pressed={scriptOutputTarget === option.value}
                  onClick={() => setWorkflowSource((current) => ({
                    ...current,
                    outputTarget: option.value,
                    videoSourceMode: option.value === "video"
                      ? current.videoSourceMode || "direct"
                      : current.videoSourceMode,
                  }))}
                >
                  {option.value === "prompts" ? <FileText size={18} /> : option.value === "images" ? <ImageIcon size={18} /> : <Clapperboard size={18} />}
                  <span><strong>{option.title}</strong><small>{option.description}</small></span>
                  {scriptOutputTarget === option.value && <Check size={15} />}
                </button>
              ))}
            </div>
            {scriptOutputTarget === "video" && (
              <>
                <div className="script-output-options is-video-source">
                  {SCRIPT_VIDEO_SOURCE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={scriptVideoSourceMode === option.value ? "is-selected" : ""}
                      type="button"
                      aria-pressed={scriptVideoSourceMode === option.value}
                      onClick={() => setWorkflowSource((current) => ({
                        ...current,
                        outputTarget: "video",
                        videoSourceMode: option.value,
                      }))}
                    >
                      {option.value === "direct" ? <Clapperboard size={18} /> : <ImageIcon size={18} />}
                      <span><strong>{option.title}</strong><small>{option.description}</small></span>
                      {scriptVideoSourceMode === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <p className="script-output-note"><ShieldCheck size={14} /> {scriptVideoSourceMode === "direct" ? "Mặc định dùng Google Flow Video trực tiếp như cấu hình trong ảnh: Video, Thành phần, 16:9 và thời lượng theo scene." : "Video bao gồm các ảnh khởi đầu cần thiết; cảnh nối tiếp dùng frame cuối thực tế để giữ continuity."}</p>
              </>
            )}
          </fieldset>

          <details className="script-advanced">
            <summary>Tùy chọn nâng cao <span>SRT, nhịp dựng và phong cách hình ảnh</span></summary>
            <div className="script-advanced-content">
              <section>
                <header><strong>Nhịp dựng</strong><small>Ảnh hưởng thời lượng ước tính cho từng đoạn.</small></header>
                <div className="script-pacing-options">
                  {SCRIPT_PACING_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={scriptPacing === option.value ? "is-selected" : ""}
                      type="button"
                      onClick={() => setWorkflowSource((current) => ({ ...current, pacing: option.value }))}
                    >
                      <strong>{option.title}</strong><small>{option.description}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <header><strong>SRT có sẵn</strong><small>Không bắt buộc. Khi có SRT, timestamp của file sẽ được ưu tiên tuyệt đối.</small></header>
                <FilePicker
                  id="timeline-srt-file"
                  label="Tải SRT để khóa thời gian"
                  accept=".srt,application/x-subrip,text/plain"
                  file={srtFile}
                  savedName={workflowSource.timingOrigin === "user_srt" ? workflowSource.srtFileName : ""}
                  onChange={selectScriptSrtFile}
                />
              </section>
              <section>
                <header><strong>Phong cách hình ảnh</strong><small>Để trống để AI xây dựng phong cách nhất quán từ toàn bộ kịch bản.</small></header>
                <VisualBiblePanel
                  value={visualBible}
                  onChange={setVisualBible}
                  presets={stylePresets}
                  presetError={stylePresetError}
                  onSavePreset={saveStylePreset}
                  onDeletePreset={deleteStylePreset}
                  styleReference={styleReference}
                  onStyleReferenceChange={setStyleReference}
                />
              </section>
            </div>
          </details>
        </section>
      ) : (
        <section className="manual-timeline-source" aria-label="Nguồn SRT và kịch bản">
          <header><p className="eyebrow">Nguồn đầu vào</p><h3>Chọn SRT và kịch bản cho chế độ không dùng Voice Studio</h3></header>
          <div className="timeline-file-grid">
            <FilePicker
              id="timeline-srt-file"
              label="Phụ đề SRT"
              accept=".srt,application/x-subrip,text/plain"
              file={srtFile}
              savedName={workflowSource.srtFileName}
              onChange={setSrtFile}
            />
            <FilePicker
              id="timeline-script-file"
              label="Kịch bản"
              accept=".txt,.md,text/plain,text/markdown"
              file={scriptFile}
              savedName={workflowSource.scriptFileName}
              onChange={setScriptFile}
            />
          </div>
          <VisualBiblePanel
            value={visualBible}
            onChange={setVisualBible}
            presets={stylePresets}
            presetError={stylePresetError}
            onSavePreset={saveStylePreset}
            onDeletePreset={deleteStylePreset}
            styleReference={styleReference}
            onStyleReferenceChange={setStyleReference}
          />
        </section>
      )}

      <div className="timeline-command-bar">
        <div className="timeline-progress" aria-live="polite">
          {running ? (
            <>
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
              <span>{progress?.message || "Đang khởi tạo timeline"}</span>
            </>
          ) : scenes.length > 0 ? (
            <span>
              {scenes.length} scene · {sessionStatus === "saving"
                ? "Đang lưu phiên"
                : sessionStatus === "error"
                  ? "Lỗi lưu phiên"
                  : "Đã lưu phiên"}
            </span>
          ) : (
            <span>Video 10–15 phút · 16:9 · scene 8 giây</span>
          )}
        </div>
        <div className="timeline-actions">
          <button className="button secondary" type="button" disabled={running || !onBack} onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            {scriptWorkflow ? "Quay lại trang chủ" : "Quay lại Visual Bible"}
          </button>
          <button className="button secondary" type="button" disabled={running || sessionStatus === "saving"} onClick={() => void saveCurrentSession()}>
            <Save size={14} aria-hidden="true" />
            {sessionStatus === "saving" ? "Đang lưu" : "Lưu bản nháp"}
          </button>
          {(startInputBlockers.length > 0 || startConnectionWarnings.length > 0) && (
            <small className={startInputBlockers.length > 0 ? "kc-start-check is-blocked" : "kc-start-check is-warning"}>
              {startInputBlockers.length > 0
                ? `Còn thiếu: ${startInputBlockers.join(", ")}`
                : startConnectionWarnings.join(" · ")}
            </small>
          )}
          {running ? (
            <button className="button secondary" type="button" onClick={cancel}>
              <Square size={14} aria-hidden="true" />
              Dừng
            </button>
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={primaryActionDisabled}
              onClick={runPrimaryAction}
            >
              {promptFilePathLoading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
              {primaryActionLabel}
            </button>
          )}
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {scenes.length > 0 && (
        <section className="production-queue-bar" aria-label="Hàng đợi sản xuất">
          <div className="production-queue-summary">
            <span className={`queue-state is-${queueSnapshot?.state || "idle"}`}>
              {queueSnapshot?.state === "running"
                ? <><LoaderCircle className="spin" size={14} /> Đang chạy</>
                : queueSnapshot?.state === "paused"
                  ? <><Pause size={14} /> Đã tạm dừng</>
                  : queueSnapshot?.state === "stopped"
                    ? <><Square size={13} /> Đã dừng</>
                    : <><Check size={14} /> Sẵn sàng</>}
            </span>
            <span>{queueSnapshot?.queuedJobs || 0} job chờ tiếp theo</span>
            {queueSnapshot?.activeSceneId && (
              <span>Đang xử lý {queueSnapshot.activeSceneId} · {queueSnapshot.activeMediaType === "image" ? "ảnh" : "video"}</span>
            )}
          </div>
          <div className="production-queue-actions">
            <div className="workflow-provider-switch is-compact" aria-label="Image generation provider">
              <span>Image provider</span>
              <button type="button" className={imageProvider === "google-flow" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeImageProvider("google-flow")}>Flow</button>
              <button type="button" className={imageProvider === "chatgpt-image" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeImageProvider("chatgpt-image")}>ChatGPT</button>
              <button type="button" className={imageProvider === "gemini-image" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeImageProvider("gemini-image")}>Gemini</button>
              <button type="button" className={imageProvider === "grok-image" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeImageProvider("grok-image")}>Grok</button>
            </div>
            <div className="workflow-provider-switch is-compact" aria-label="Video generation provider">
              <span>Video provider</span>
              <button type="button" className={videoProvider === "google-flow" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeVideoProvider("google-flow")}>Flow</button>
              <button type="button" className={videoProvider === "gemini-video" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeVideoProvider("gemini-video")}>Gemini</button>
              <button type="button" className={videoProvider === "grok-video" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeVideoProvider("grok-video")}>Grok</button>
              <button type="button" className={videoProvider === "capcut-video" ? "is-selected" : ""} disabled={workflowBusy} onClick={() => changeVideoProvider("capcut-video")}>CapCut</button>
            </div>
            <label className="queue-policy-toggle">
              <input
                type="checkbox"
                checked={queueSnapshot?.autoApproveImages || false}
                onChange={(event) => {
                  const bridge = window.flowx?.productionQueue;
                  if (!bridge) return;
                  void runQueueCommand(
                    () => bridge.setApprovalPolicy(
                      event.target.checked,
                      queueSnapshot?.autoApproveVideos || false,
                      activeProjectId,
                    ),
                    false,
                  );
                }}
              />
              Tự duyệt ảnh; ảnh xong tự xếp video
            </label>
            <button
              className="button primary compact"
              type="button"
              disabled={scriptDirectVideo ? !videoProviderConnected : !imageProviderConnected}
              title={scriptDirectVideo ? "Tạo video trực tiếp từ prompt cho từng scene" : "Chạy lần lượt ảnh scene 1 → video scene 1 → ảnh scene 2 → video scene 2"}
              onClick={startSelectedProductionPipeline}
            >
              <Sparkles size={15} /> {scriptDirectVideo ? "Chạy video trực tiếp" : workflowMode === "two_step" ? "Chạy tạo ảnh & video" : "Tiếp tục tự động"}
            </button>
            <button
              className="button secondary compact"
              type="button"
              disabled={!imageProviderConnected}
              onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.generateAllImages(activeProjectId, { imageProvider }));
              }}
            >
              <ImageIcon size={15} /> Tạo toàn bộ ảnh
            </button>
            <button
              className="button secondary compact"
              type="button"
              disabled={!videoProviderConnected}
              onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.generateAllVideos(
                  activeProjectId,
                  { onlyApprovedImages: false, videoMode: "text-to-video", delivery: workflowSource.directVideoDelivery || "download", videoProvider },
                ));
              }}
            >
              <Clapperboard size={15} /> Tạo video trực tiếp
            </button>
            <button
              className="button secondary compact"
              type="button"
              disabled={!videoProviderConnected}
              onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.generateAllVideos(
                  activeProjectId,
                  { onlyApprovedImages: true, delivery: "download", videoProvider },
                ));
              }}
            >
              <Play size={15} /> Tạo video đã duyệt
            </button>
            {completedVideoCount === scenes.length && scenes.length > 0 && (
              <button
                className="button primary compact is-build-ready"
                type="button"
                onClick={onBuildVideo}
              >
                <Clapperboard size={15} /> Dựng video hoàn chỉnh
              </button>
            )}
            <button
              className="button danger compact"
              type="button"
              disabled={clearingGeneratedMedia || Boolean(clearingSceneId)}
              title="Xóa ảnh, video và frame trên máy; giữ nguyên câu lệnh và thư viện provider"
              onClick={() => setClearMediaConfirmOpen(true)}
            >
              {clearingGeneratedMedia
                ? <LoaderCircle className="spin" size={15} />
                : <Trash2 size={15} />}
              Xóa kết quả
            </button>
            {queueSnapshot?.state === "running" ? (
              <button className="icon-button" type="button" title="Tạm dừng sau job hiện tại" onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.pauseQueue(activeProjectId), false);
              }}><Pause size={16} /></button>
            ) : (queueSnapshot?.state === "paused" || queueSnapshot?.state === "stopped") ? (
              <button className="icon-button" type="button" title="Tiếp tục hàng đợi" onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.resumeQueue(activeProjectId), false);
              }}><Play size={16} /></button>
            ) : null}
            {(queueSnapshot?.state === "running" || queueSnapshot?.state === "paused") && (
              <button className="icon-button danger-icon" type="button" title="Dừng hàng đợi" onClick={() => {
                const bridge = window.flowx?.productionQueue;
                if (bridge) void runQueueCommand(() => bridge.stopQueue(activeProjectId), false);
              }}><Square size={15} /></button>
            )}
          </div>
        </section>
      )}
      {queueCommandError && <div className="form-error">{queueCommandError}</div>}
      {workflowNotice && <div className="form-success">{workflowNotice}</div>}
      {clearMediaNotice && <div className="form-success">{clearMediaNotice}</div>}

      {(hasSrtInput || hasScriptInput || scenes.length > 0) && (
        <section className="workflow-output-panel" aria-label="Đầu vào và đầu ra của phiên">
          <header>
            <div>
              <p className="eyebrow">Hồ sơ dự án</p>
              <h3>Đầu vào và đầu ra được giữ theo phiên</h3>
            </div>
            <span>{completedVideoCount}/{scenes.length || 0} source video hoàn tất</span>
          </header>
          <div className="workflow-output-grid">
            <article>
              <FileText size={17} />
              <div><strong>SRT</strong><span>{srtFile?.name || workflowSource.srtFileName || (hasDeferredVoice ? "Sẽ tạo tự động khi bấm Bắt đầu" : "Chưa có")}</span></div>
            </article>
            <article>
              <FileText size={17} />
              <div><strong>Voice</strong><span>{workflowSource.audioFileName || (hasDeferredVoice ? `Đã liên kết Voice Studio · ${workflowVoiceLabel || workflowSource.voiceName}` : importedVoiceAudio ? "Chưa chọn MP3" : "Phiên không sử dụng Voice Studio")}</span></div>
            </article>
            <article>
              <Play size={17} />
              <div><strong>Source ảnh & video</strong><span>{projectOutputFolder(activeProjectId, sessionNameDraft)}</span></div>
            </article>
          </div>
        </section>
      )}
      <ErrorCenter
        errors={queueSnapshot?.errors || []}
        onRetry={(sceneIds) => {
          const bridge = window.flowx?.productionQueue;
          if (bridge) void runQueueCommand(() => bridge.retryFailed(sceneIds, activeProjectId));
        }}
      />
      {scenes.length > 0 ? (
        <>
          <details className="workflow-batch-editor">
            <summary><PencilLine size={15} /> Bảng chỉnh prompt và planning hàng loạt</summary>
          <TimelineTable scenes={scenes} errors={sceneErrors} thumbnails={thumbnails} onPromptChange={updatePrompt} onPlanningChange={updatePlanning} onRun={runOrRegenerateScene} onRegenerate={regenerateQueuedScene} onResumeFrom={resumeQueueFromScene} onClearSceneMedia={setClearSceneMediaTarget} onApprove={approveQueuedScene} onReject={rejectQueuedScene} onRepairPolicy={openPolicyRepairModal} repairingPromptKey={repairingPromptKey} clearingSceneId={clearingSceneId} textWorkerConnected={textWorkerConnected} textProviderLabel={textProviderLabel} />
          </details>
        </>
      ) : (
        <p className="empty-state timeline-empty">Chưa có dữ liệu scene.</p>
      )}

      {policyRepairModal && (() => {
        const scene = scenes.find((entry) => entry.id === policyRepairModal.sceneId);
        const selectedOption = POLICY_REASON_OPTIONS.find((option) => option.value === policyReason);
        return (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !repairingPromptKey) {
              setPolicyRepairModal(null);
            }
          }}>
            <section className="policy-repair-modal" role="dialog" aria-modal="true" aria-labelledby="policy-repair-title">
              <header>
                <div>
                  <p className="eyebrow">Provider safety</p>
                  <h3 id="policy-repair-title">
                    Sửa prompt {policyRepairModal.mediaType === "image" ? "ảnh" : "video"}
                    {scene ? ` · Scene ${scene.order}` : ""}
                  </h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  title="Đóng"
                  disabled={Boolean(repairingPromptKey)}
                  onClick={() => setPolicyRepairModal(null)}
                >
                  <X size={18} />
                </button>
              </header>

              {policyRepairModal.detectedError && (
                <div className="policy-detected-error" role="status">
                  <CircleAlert size={16} />
                  <div>
                    <strong>App đọc được từ Flow</strong>
                    <p>{policyRepairModal.detectedError}</p>
                  </div>
                </div>
              )}

              <div className="policy-reason-list" role="radiogroup" aria-label="Loại vi phạm chính sách">
                {POLICY_REASON_OPTIONS.map((option) => (
                  <label key={option.value} className={policyReason === option.value ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="policy-reason"
                      value={option.value}
                      checked={policyReason === option.value}
                      onChange={() => setPolicyReason(option.value)}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
              </div>

              <label className="field policy-detail-field">
                <span>Thông báo hoặc lý do bổ sung</span>
                <textarea
                  value={policyDetail}
                  maxLength={2_000}
                  placeholder="Dán nguyên văn thông báo trên card render, hoặc mô tả chi tiết nào cần làm nhẹ đi…"
                  onChange={(event) => setPolicyDetail(event.target.value)}
                />
                <small>
                  {textProviderLabel} chỉ làm mềm phần có nguy cơ vi phạm; vẫn phải giữ nguyên câu chuyện, nhân vật, bối cảnh và chuyển động.
                </small>
              </label>

              <footer>
                <div className="policy-selected-summary">
                  <ShieldCheck size={15} />
                  <span>{selectedOption?.label}</span>
                </div>
                <button
                  className="button secondary"
                  type="button"
                  disabled={Boolean(repairingPromptKey)}
                  onClick={() => setPolicyRepairModal(null)}
                >
                  Hủy
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={!textWorkerConnected || Boolean(repairingPromptKey)}
                  onClick={() => void repairPolicyPromptAndResume(
                    policyRepairModal.sceneId,
                    policyRepairModal.mediaType,
                    policyReason,
                    policyDetail,
                  )}
                >
                  {repairingPromptKey
                    ? <LoaderCircle className="spin" size={15} />
                    : <ShieldCheck size={15} />}
                  Sửa và chạy tiếp
                </button>
              </footer>
            </section>
          </div>
        );
      })()}

      {clearMediaConfirmOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !clearingGeneratedMedia) {
            setClearMediaConfirmOpen(false);
          }
        }}>
          <section className="session-reset-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-media-title">
            <header>
              <div>
                <p className="eyebrow">Xác nhận xóa kết quả</p>
                <h3 id="clear-media-title">Xóa toàn bộ kết quả đã tải về máy?</h3>
              </div>
              <button
                className="icon-button"
                type="button"
                title="Đóng"
                disabled={clearingGeneratedMedia}
                onClick={() => setClearMediaConfirmOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              App sẽ dừng hàng đợi rồi xóa toàn bộ công việc, ảnh scene, video và frame trung gian trong thư mục Vyren AI trên máy. Thao tác này không thể hoàn tác. Kịch bản cảnh, câu lệnh ảnh/video, Visual Bible và gán nhân vật được giữ nguyên.
            </p>
            <p>
              Lưu ý: nút này không xóa ảnh hoặc video đang nằm trong thư viện dự án Google Flow. Nội dung đó phải được xóa riêng trên Google Flow.
            </p>
            <footer>
              <button
                className="button secondary"
                type="button"
                disabled={clearingGeneratedMedia}
                onClick={() => setClearMediaConfirmOpen(false)}
              >
                Hủy
              </button>
              <button
                className="button danger"
                type="button"
                disabled={clearingGeneratedMedia}
                onClick={() => void clearAllGeneratedMedia()}
              >
                {clearingGeneratedMedia && <LoaderCircle className="spin" size={15} />}
                Xác nhận xóa kết quả
              </button>
            </footer>
          </section>
        </div>
      )}

      {clearSceneMediaTarget && (() => {
        const targetScene = scenes.find((scene) => scene.id === clearSceneMediaTarget);
        return (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !clearingSceneId) {
              setClearSceneMediaTarget(null);
            }
          }}>
            <section className="session-reset-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-scene-media-title">
              <header>
                <div>
                  <p className="eyebrow">Xóa kết quả một scene</p>
                  <h3 id="clear-scene-media-title">
                    Xóa kết quả Scene {targetScene?.order || clearSceneMediaTarget}?
                  </h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  title="Đóng"
                  disabled={Boolean(clearingSceneId)}
                  onClick={() => setClearSceneMediaTarget(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <p>
                App sẽ dừng hàng đợi, xóa ảnh, video, frame trung gian và công việc của riêng scene này trên máy. Câu lệnh ảnh/video, gán nhân vật và kịch bản cảnh vẫn được giữ nguyên.
              </p>
              <p>Nội dung đã tạo trong thư viện của provider không bị xóa.</p>
              <footer>
                <button
                  className="button secondary"
                  type="button"
                  disabled={Boolean(clearingSceneId)}
                  onClick={() => setClearSceneMediaTarget(null)}
                >
                  Hủy
                </button>
                <button
                  className="button danger"
                  type="button"
                  disabled={Boolean(clearingSceneId)}
                  onClick={() => void clearOneSceneMedia()}
                >
                  {clearingSceneId && <LoaderCircle className="spin" size={15} />}
                  Xác nhận xóa scene này
                </button>
              </footer>
            </section>
          </div>
        );
      })()}

      {resetConfirmOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setResetConfirmOpen(false);
        }}>
          <section className="session-reset-modal" role="alertdialog" aria-modal="true" aria-labelledby="session-reset-title">
            <header>
              <div>
                <p className="eyebrow">Xác nhận xóa phiên</p>
                <h3 id="session-reset-title">Xóa phiên “{sessionNameDraft}”?</h3>
              </div>
              <button className="icon-button" type="button" title="Đóng" onClick={() => setResetConfirmOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <p>Timeline, trạng thái scene, prompt, Visual Bible và ảnh phong cách mẫu của riêng phiên này sẽ bị xóa. Những phiên khác và các ảnh hoặc video đã tải xuống máy vẫn được giữ nguyên.</p>
            <footer>
              <button className="button secondary" type="button" onClick={() => setResetConfirmOpen(false)}>Giữ phiên</button>
              <button className="button danger" type="button" disabled={switchingSession || sessionDeleteLocked} onClick={() => void deleteActiveSession()}>
                {switchingSession && <LoaderCircle className="spin" size={15} />}
                Xác nhận xóa phiên
              </button>
            </footer>
          </section>
        </div>
      )}

      {imageModal && (() => {
        const scene = scenes.find((entry) => entry.id === imageModal.sceneId);
        return scene ? (
          <ImageGenerationModal
            scene={scene}
            initialPrompt={imageModal.prompt}
            characters={characters}
            visualBible={visualBible}
            imageProvider={imageProvider}
            onClose={() => setImageModal(null)}
            onGenerate={confirmImageGeneration}
          />
        ) : null;
      })()}

      {videoModal && (() => {
        const scene = scenes.find((entry) => entry.id === videoModal.sceneId);
        return scene ? (
          <VideoGenerationModal
            scene={scene}
            initialPrompt={videoModal.prompt}
            thumbnail={thumbnails[scene.id]}
            visualBible={visualBible}
            videoProvider={videoProvider}
            onClose={() => setVideoModal(null)}
            onGenerate={confirmVideoGeneration}
          />
        ) : null;
      })()}
    </section>
  );
}
