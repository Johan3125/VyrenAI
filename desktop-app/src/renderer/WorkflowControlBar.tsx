import {
  Bot,
  Clapperboard,
  FileDown,
  Film,
  Image as ImageIcon,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import {
  DEFAULT_IMAGE_GENERATION_PROVIDER,
  DEFAULT_VIDEO_GENERATION_PROVIDER,
  type ImageGenerationProvider,
  type VideoGenerationProvider,
} from "../shared/scene-job";
import type { WorkflowSceneView } from "./workflow-scene-view";

export function WorkflowControlBar({
  scenes,
  snapshot,
  imageConnected,
  videoConnected,
  directVideo = false,
  imageProviderLabel,
  videoProviderLabel,
  imageProvider = snapshot?.imageProvider || DEFAULT_IMAGE_GENERATION_PROVIDER,
  videoProvider = snapshot?.videoProvider || DEFAULT_VIDEO_GENERATION_PROVIDER,
  busy,
  onStart,
  onGenerateImages,
  onGenerateVideos,
  onGenerateDirectVideos,
  onCollectSubmittedVideos,
  onPause,
  onResume,
  onStop,
  onRetryErrors,
  onClearResults,
  onBuildVideo,
  onRefresh,
  onImageProviderChange,
  onVideoProviderChange,
}: {
  scenes: WorkflowSceneView[];
  snapshot: ProductionQueueSnapshot | null;
  imageConnected: boolean;
  videoConnected: boolean;
  directVideo?: boolean;
  imageProviderLabel: string;
  videoProviderLabel: string;
  imageProvider?: ImageGenerationProvider;
  videoProvider?: VideoGenerationProvider;
  busy: boolean;
  onStart: () => void;
  onGenerateImages: () => void;
  onGenerateVideos: () => void;
  onGenerateDirectVideos: () => void;
  onCollectSubmittedVideos: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetryErrors: () => void;
  onClearResults: () => void;
  onBuildVideo: () => void;
  onRefresh: () => void;
  onImageProviderChange: (provider: ImageGenerationProvider) => void;
  onVideoProviderChange: (provider: VideoGenerationProvider) => void;
}) {
  const running = snapshot?.state === "running";
  const paused = snapshot?.state === "paused";
  const stoppable = running || paused || Boolean(snapshot?.activeJobId);
  const videosReady = scenes.length > 0 && scenes.every((item) => item.videoStatus === "completed" || item.videoStatus === "approved");
  const submittedVideos = scenes.filter((item) => item.videoStatus === "submitted").length;
  const hasErrors = Boolean(snapshot?.errors.length);
  return (
    <section className="workflow-control-bar" aria-label="Điều khiển workflow">
      {!directVideo && <div className="workflow-provider-switch" aria-label="Image generation provider">
        <span>Image provider</span>
        <button type="button" className={imageProvider === "google-flow" ? "is-selected" : ""} disabled={running || busy} onClick={() => onImageProviderChange("google-flow")}><ImageIcon size={14} /> Flow</button>
        <button type="button" className={imageProvider === "chatgpt-image" ? "is-selected" : ""} disabled={running || busy} onClick={() => onImageProviderChange("chatgpt-image")}><Bot size={14} /> ChatGPT</button>
        <button type="button" className={imageProvider === "gemini-image" ? "is-selected" : ""} disabled={running || busy} onClick={() => onImageProviderChange("gemini-image")}><Bot size={14} /> Gemini</button>
        <button type="button" className={imageProvider === "grok-image" ? "is-selected" : ""} disabled={running || busy} onClick={() => onImageProviderChange("grok-image")}><Bot size={14} /> Grok</button>
      </div>}
      <div className="workflow-provider-switch" aria-label="Video generation provider">
        <span>Video provider</span>
        <button type="button" className={videoProvider === "google-flow" ? "is-selected" : ""} disabled={running || busy} onClick={() => onVideoProviderChange("google-flow")}><Play size={14} /> Flow</button>
        <button type="button" className={videoProvider === "gemini-video" ? "is-selected" : ""} disabled={running || busy} onClick={() => onVideoProviderChange("gemini-video")}><Bot size={14} /> Gemini</button>
        <button type="button" className={videoProvider === "grok-video" ? "is-selected" : ""} disabled={running || busy} onClick={() => onVideoProviderChange("grok-video")}><Bot size={14} /> Grok</button>
        <button type="button" className={videoProvider === "capcut-video" ? "is-selected" : ""} disabled={running || busy} onClick={() => onVideoProviderChange("capcut-video")}><Bot size={14} /> CapCut</button>
      </div>
      <button className="workflow-control is-primary" type="button" disabled={(directVideo ? !videoConnected : !imageConnected) || running || busy} title={directVideo ? !videoConnected ? `${videoProviderLabel} chưa kết nối` : "Bắt đầu tạo video trực tiếp từ prompt" : !imageConnected ? `${imageProviderLabel} chưa kết nối` : undefined} onClick={onStart}><Sparkles size={15} /> Bắt đầu toàn bộ workflow</button>
      {!directVideo && <button className="workflow-control is-primary" type="button" disabled={!imageConnected || running || busy} title={!imageConnected ? `${imageProviderLabel} chưa kết nối` : undefined} onClick={onGenerateImages}><ImageIcon size={15} /> Tạo toàn bộ ảnh</button>}
      <button className="workflow-control is-direct" type="button" disabled={!videoConnected || running || busy} title={!videoConnected ? `${videoProviderLabel} chưa kết nối` : "Tạo video trực tiếp từ prompt, không cần ảnh đã duyệt"} onClick={onGenerateDirectVideos}><Film size={15} /> Tạo video trực tiếp</button>
      <button className="workflow-control is-collect" type="button" disabled={!videoConnected || running || busy || submittedVideos === 0} title={submittedVideos ? "Chạy lại prompt đã gửi ở chế độ tải file để đưa video vào app" : "Không có video đã gửi Flow cần thu thập"} onClick={onCollectSubmittedVideos}><FileDown size={15} /> Thu thập video ({submittedVideos})</button>
      {!directVideo && <button className="workflow-control is-primary" type="button" disabled={!videoConnected || running || busy} title={!videoConnected ? `${videoProviderLabel} chưa kết nối` : undefined} onClick={onGenerateVideos}><Play size={15} /> Tạo video đã duyệt</button>}
      <button className="workflow-control is-pause" type="button" disabled={!running || busy} onClick={onPause}><Pause size={15} /> Tạm dừng</button>
      <button className="workflow-control is-resume" type="button" disabled={!paused || busy} onClick={onResume}><Play size={15} /> Tiếp tục</button>
      <button className="workflow-control is-stop" type="button" disabled={!stoppable || busy} onClick={() => { if (window.confirm("Dừng toàn bộ workflow của phiên hiện tại? Công việc đang chạy sẽ được yêu cầu hủy.")) onStop(); }}><Square size={14} /> Dừng</button>
      <button className="workflow-control is-retry" type="button" disabled={!hasErrors || running || busy} onClick={onRetryErrors}><RotateCcw size={15} /> Thử lại tất cả lỗi</button>
      <button className="workflow-control is-clear" type="button" disabled={running || busy} onClick={onClearResults}><Trash2 size={15} /> Xóa kết quả, giữ timeline/prompt</button>
      <button className="workflow-control is-build" type="button" disabled={!videosReady || busy} onClick={onBuildVideo}><Clapperboard size={15} /> Dựng video khi đạt 100%</button>
      <button className="workflow-control-icon" type="button" title="Làm mới trạng thái queue" disabled={busy} aria-label="Làm mới trạng thái queue" onClick={onRefresh}><RefreshCcw size={15} /></button>
    </section>
  );
}
