import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Info,
  ListTodo,
  LoaderCircle,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { WorkflowSceneView } from "./workflow-scene-view";

export function WorkflowHeader({
  sessionName,
  scenes,
  snapshot,
  imageConnected,
  videoConnected = true,
  directVideo = false,
  onAutoApproveChange,
  onVideoAutoApproveChange,
  verifiedBuildMessage = null,
}: {
  sessionName: string;
  scenes: WorkflowSceneView[];
  snapshot: ProductionQueueSnapshot | null;
  imageConnected: boolean;
  videoConnected?: boolean;
  directVideo?: boolean;
  onAutoApproveChange: (enabled: boolean) => void;
  onVideoAutoApproveChange?: (enabled: boolean) => void;
  verifiedBuildMessage?: string | null;
}) {
  const [bannerVisible, setBannerVisible] = useState(true);
  const completed = scenes.filter((item) => item.videoStatus === "completed" || item.videoStatus === "approved").length;
  const submitted = scenes.filter((item) => item.videoStatus === "submitted").length;
  const visibleProgress = Math.max(completed, submitted);
  const percent = scenes.length ? Math.round(visibleProgress / scenes.length * 100) : 0;
  const current = scenes.find((item) => item.scene.id === snapshot?.activeSceneId) || null;
  const errorScenes = new Set(snapshot?.errors.map((error) => error.sceneId) || []).size;

  return (
    <section className="workflow-overview" aria-label="Tổng quan workflow">
      <div className="workflow-overview-session">
        <span className={`workflow-live-dot ${snapshot?.state === "running" ? "is-running" : ""}`} />
        <div><small>PHIÊN LÀM VIỆC</small><strong>Session: {sessionName}</strong></div>
      </div>
      <div className="workflow-overview-progress">
        <span className="workflow-progress-ring" style={{ "--workflow-progress": `${percent * 3.6}deg` } as React.CSSProperties}>{percent}%</span>
        <div><small>Tổng tiến độ</small><strong>{submitted > completed ? `${completed} tải · ${submitted} gửi / ${scenes.length}` : `${completed} / ${scenes.length} scene`}</strong><i><span style={{ width: `${percent}%` }} /></i></div>
      </div>
      <div className="workflow-overview-current">
        <span><Clapperboard size={18} /></span>
        <div><small>Scene hiện tại</small><strong>{current ? `Scene ${current.scene.order}` : "Không có"}</strong><em>{current ? snapshot?.activeMediaType === "image" ? "Đang xử lý ảnh…" : "Đang xử lý video…" : snapshot?.state === "paused" ? "Workflow đang tạm dừng" : "Worker đang rảnh"}</em></div>
        {current && <LoaderCircle className="spin" size={15} />}
      </div>
      <div className="workflow-overview-metric is-waiting"><ListTodo size={18} /><div><strong>{snapshot?.queuedJobs || 0}</strong><small>job trong hàng đợi</small></div></div>
      <div className="workflow-overview-metric is-error"><AlertTriangle size={18} /><div><strong>{errorScenes}</strong><small>scene bị lỗi</small></div></div>
      <label className="workflow-auto-approve">
        <span>{directVideo ? "Tự động duyệt video" : "Tự động duyệt ảnh"} <Info size={12} aria-label={directVideo ? "Video hoàn thành sẽ tự động được duyệt theo cấu hình queue" : "Ảnh hoàn thành sẽ tự động được duyệt theo cấu hình queue"} /></span>
        <button type="button" role="switch" aria-checked={directVideo ? snapshot?.autoApproveVideos || false : snapshot?.autoApproveImages || false} disabled={directVideo ? !videoConnected : !imageConnected} className={(directVideo ? snapshot?.autoApproveVideos : snapshot?.autoApproveImages) ? "is-on" : ""} onClick={() => directVideo ? onVideoAutoApproveChange?.(!(snapshot?.autoApproveVideos || false)) : onAutoApproveChange(!(snapshot?.autoApproveImages || false))}><i /><b>{(directVideo ? snapshot?.autoApproveVideos : snapshot?.autoApproveImages) ? "BẬT" : "TẮT"}</b></button>
      </label>
      {verifiedBuildMessage && bannerVisible && (
        <div className="workflow-build-banner" role="status"><CheckCircle2 size={17} /><span>{verifiedBuildMessage}</span><button type="button" aria-label="Đóng thông báo kiểm thử" onClick={() => setBannerVisible(false)}><X size={14} /></button></div>
      )}
    </section>
  );
}
