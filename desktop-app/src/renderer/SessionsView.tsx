import { CalendarClock, CheckCircle2, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { TimelineSessionSummary } from "../shared/timeline";

export function SessionsView({
  sessions,
  queues,
  onCreate,
  onOpen,
  onRename,
  onDelete,
}: {
  sessions: TimelineSessionSummary[];
  queues: Record<string, ProductionQueueSnapshot>;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="kc-sessions-view">
      <header className="kc-section-heading"><div><span>PROJECT WORKSPACES</span><h2>Tất cả phiên làm việc</h2><p>Mỗi phiên giữ riêng voice, SRT, prompt, scene và kết quả Flow.</p></div><button type="button" className="is-primary" onClick={onCreate}><Plus size={15} /> Tạo phiên mới</button></header>
      <div className="kc-session-card-grid">
        {sessions.map((session) => {
          const queue = queues[session.id];
          const completed = queue?.scenes.filter((scene) => scene.videoAssetPath).length || 0;
          const percent = session.sceneCount ? Math.round((completed / session.sceneCount) * 100) : 0;
          return (
            <article key={session.id} className={session.active ? "is-active" : ""}>
              <header><span className={`kc-status-dot is-${queue?.errors.length ? "error" : queue?.state === "running" ? "running" : "waiting"}`} /><div><strong>{session.name}</strong><small>{session.workflowMode === "automatic" ? "Tự động toàn bộ" : "Tạo từng bước"}</small></div><MoreHorizontal size={16} /></header>
              <div className="kc-session-card-stats"><span><b>{session.sceneCount}</b> scene</span><span><b>{completed}</b> video</span><span><b>{queue?.errors.length || 0}</b> lỗi</span></div>
              <div className="kc-session-card-progress"><i><span style={{ width: `${percent}%` }} /></i><small>{percent}% hoàn thành</small></div>
              <p><CalendarClock size={13} /> Lưu {new Date(session.savedAt).toLocaleString("vi-VN")}</p>
              <footer><button type="button" className="is-primary" onClick={() => onOpen(session.id)}>{session.active ? <CheckCircle2 size={14} /> : <Play size={14} />}{session.active ? "Đang mở" : "Mở phiên"}</button><button type="button" onClick={() => onRename(session.id)}>Đổi tên</button><button type="button" className="is-danger" onClick={() => onDelete(session.id)}><Trash2 size={14} /></button></footer>
            </article>
          );
        })}
        {!sessions.length && <div className="kc-empty-panel">Chưa có phiên làm việc.</div>}
      </div>
    </section>
  );
}

