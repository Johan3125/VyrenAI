import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  FileOutput,
  House,
  MoreHorizontal,
  Plus,
  Settings,
} from "lucide-react";
import { useState } from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import { APP_BRAND_NAME, APP_BRAND_TAGLINE } from "../shared/brand";
import type { TimelineSessionSummary } from "../shared/timeline";
import type { AppPage } from "./app-navigation";
import vyrenLogo from "./assets/vyren-logo.png";

const NAVIGATION: Array<{ page: AppPage; label: string; icon: typeof House }> = [
  { page: "home", label: "Trang chủ", icon: House },
  { page: "timeline", label: "Kịch bản cảnh", icon: Clapperboard },
  { page: "queue", label: "Sản xuất", icon: Clapperboard },
  { page: "output", label: "Kết quả", icon: FileOutput },
  { page: "settings", label: "Cài đặt", icon: Settings },
];

function sessionStatus(
  summary: TimelineSessionSummary,
  snapshot: ProductionQueueSnapshot | undefined,
): { label: string; tone: string } {
  if (snapshot?.errors.length) return { label: "Lỗi", tone: "error" };
  if (snapshot?.state === "running") return { label: "Đang sản xuất", tone: "running" };
  if (snapshot?.state === "paused" || snapshot?.state === "stopped") {
    return { label: "Tạm dừng", tone: "paused" };
  }
  if (snapshot?.queuedJobs) return { label: "Đang chờ", tone: "waiting" };
  if (summary.sceneCount > 0 && snapshot?.scenes.length && snapshot.scenes.every((scene) => Boolean(scene.videoAssetPath))) {
    return { label: "Hoàn thành", tone: "complete" };
  }
  if (summary.sceneCount > 0) return { label: "Đang phân tích", tone: "analysis" };
  return { label: "Đang chờ", tone: "waiting" };
}

export function Sidebar({
  page,
  collapsed,
  sessions,
  sessionQueues,
  errorCount,
  workflowActivePage,
  onNavigate,
  onCreateSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onToggleCollapsed,
}: {
  page: AppPage;
  collapsed: boolean;
  sessions: TimelineSessionSummary[];
  sessionQueues: Record<string, ProductionQueueSnapshot>;
  errorCount: number;
  workflowActivePage: AppPage | null;
  onNavigate: (page: AppPage) => void;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onToggleCollapsed: () => void;
}) {
  const [menuSessionId, setMenuSessionId] = useState("");
  const activeQueue = sessionQueues[sessions.find((session) => session.active)?.id || ""];
  const queueBadge = activeQueue?.queuedJobs || activeQueue?.errors.length || errorCount;

  return (
    <aside className={`kc-sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="kc-brand-block">
        <div className="kc-logo" aria-hidden="true"><img src={vyrenLogo} alt="" /></div>
        {!collapsed && <div><strong>{APP_BRAND_NAME}</strong><span>{APP_BRAND_TAGLINE}</span></div>}
      </div>

      <button className="kc-new-session" type="button" onClick={onCreateSession} title="Tạo phiên mới">
        <Plus size={17} />{!collapsed && <span>Tạo phiên mới</span>}
      </button>

      <nav className="kc-nav" aria-label="Điều hướng chính">
        {NAVIGATION.map((item) => {
          const Icon = item.icon;
          const badge = item.page === "queue" ? queueBadge : 0;
          return (
            <button
              key={item.page}
              type="button"
              className={`${page === item.page ? "is-active" : ""} ${workflowActivePage === item.page ? "is-progress-active" : ""}`.trim()}
              aria-current={page === item.page ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              onClick={() => onNavigate(item.page)}
            >
              <Icon size={17} />
              {!collapsed && <span>{item.label}</span>}
              {badge > 0 && <b>{badge}</b>}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <section className="kc-session-section">
          <header>PHIÊN LÀM VIỆC</header>
          <div className="kc-session-list">
            {sessions.slice(0, 7).map((summary) => {
              const status = sessionStatus(summary, sessionQueues[summary.id]);
              const errors = sessionQueues[summary.id]?.errors.length || 0;
              return (
                <article key={summary.id} className={summary.active ? "is-active" : ""}>
                  <button className="kc-session-main" type="button" onClick={() => onSelectSession(summary.id)}>
                    <span className={`kc-status-dot is-${status.tone}`} />
                    <span><strong>{summary.name}</strong><small>{status.label}</small></span>
                    {errors > 0 && <b>{errors}</b>}
                  </button>
                  <button
                    className="kc-session-more"
                    type="button"
                    aria-label={`Thao tác ${summary.name}`}
                    onClick={() => setMenuSessionId((current) => current === summary.id ? "" : summary.id)}
                  ><MoreHorizontal size={15} /></button>
                  {menuSessionId === summary.id && (
                    <div className="kc-session-menu">
                      <button type="button" onClick={() => { onSelectSession(summary.id); setMenuSessionId(""); }}>Mở phiên</button>
                      <button type="button" onClick={() => { onRenameSession(summary.id); setMenuSessionId(""); }}>Đổi tên</button>
                      <button type="button" className="is-danger" onClick={() => { onDeleteSession(summary.id); setMenuSessionId(""); }}>Xóa phiên</button>
                    </div>
                  )}
                </article>
              );
            })}
            {!sessions.length && <p>Chưa có phiên.</p>}
          </div>
        </section>
      )}

      <div className="kc-sidebar-footer">
        <button className="kc-collapse" type="button" onClick={onToggleCollapsed} title={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </aside>
  );
}
