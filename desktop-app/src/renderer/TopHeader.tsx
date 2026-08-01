import { Bell, Check, Play, Search, Settings, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineSessionSummary } from "../shared/timeline";
import type { WorkerStatuses } from "../shared/worker-status";
import { PAGE_COPY, type AppPage } from "./app-navigation";
import {
  DEFAULT_PROVIDER_SETTINGS,
  IMAGE_PROVIDER_LABEL,
  IMAGE_PROVIDER_WORKER_ROLE,
  TEXT_PROVIDER_LABEL,
  TEXT_PROVIDER_WORKER_ROLE,
  VIDEO_PROVIDER_LABEL,
  VIDEO_PROVIDER_WORKER_ROLE,
  type ProviderSettings,
} from "../shared/provider";

const SEARCHABLE_PAGES: AppPage[] = [
  "home", "sessions", "timeline", "queue", "output", "settings",
];

export function TopHeader({
  page,
  sessionName,
  sessions,
  errorCount,
  saving,
  sessionSavedAt,
  workers,
  onNavigate,
  onSave,
  onSelectSession,
  onContinueProject,
}: {
  page: AppPage;
  sessionName: string;
  sessions: TimelineSessionSummary[];
  errorCount: number;
  saving: boolean;
  sessionSavedAt: string;
  workers: WorkerStatuses;
  onNavigate: (page: AppPage) => void;
  onSave: () => void;
  onSelectSession: (id: string) => void;
  onContinueProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(
    DEFAULT_PROVIDER_SETTINGS,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const copy = PAGE_COPY[page];
  const savedAt = sessionSavedAt ? new Date(sessionSavedAt) : null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    let active = true;
    const refreshProvider = () => {
      void window.flowx?.providerSettings.get().then((settings) => {
        if (active) setProviderSettings(settings);
      });
    };
    refreshProvider();
    window.addEventListener("vyren-provider-settings-changed", refreshProvider);
    return () => {
      active = false;
      window.removeEventListener("vyren-provider-settings-changed", refreshProvider);
    };
  }, []);
  const textWorkerRole = TEXT_PROVIDER_WORKER_ROLE[providerSettings.textProvider];
  const textProviderLabel = TEXT_PROVIDER_LABEL[providerSettings.textProvider];
  const textWorkerConnected = workers[textWorkerRole]?.connected === true;
  const imageWorkerRole = IMAGE_PROVIDER_WORKER_ROLE[providerSettings.imageProvider];
  const videoWorkerRole = VIDEO_PROVIDER_WORKER_ROLE[providerSettings.videoProvider];
  const imageWorkerConnected = workers[imageWorkerRole]?.connected === true;
  const videoWorkerConnected = workers[videoWorkerRole]?.connected === true;
  const imageProviderLabel = IMAGE_PROVIDER_LABEL[providerSettings.imageProvider];
  const videoProviderLabel = VIDEO_PROVIDER_LABEL[providerSettings.videoProvider];
  const results = useMemo(() => {
    const folded = query.trim().toLocaleLowerCase("vi-VN");
    if (!folded) return [];
    return [
      ...SEARCHABLE_PAGES.filter((candidate) =>
        `${PAGE_COPY[candidate].title} ${PAGE_COPY[candidate].description}`.toLocaleLowerCase("vi-VN").includes(folded)
      ).map((candidate) => ({ id: `page:${candidate}`, label: PAGE_COPY[candidate].title, kind: "Màn hình", run: () => onNavigate(candidate) })),
      ...sessions.filter((session) => session.name.toLocaleLowerCase("vi-VN").includes(folded))
        .map((session) => ({ id: `session:${session.id}`, label: session.name, kind: "Phiên", run: () => onSelectSession(session.id) })),
    ].slice(0, 7);
  }, [query, sessions, onNavigate, onSelectSession]);

  return (
    <header className="kc-top-header">
      <div className="kc-page-heading">
        <span>{sessionName || "Chưa có phiên"}</span>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      <div className="kc-header-actions">
        <button className="kc-header-save" type="button" onClick={onSave} disabled={saving}>
          <Check size={15} /> {saving ? "Đang lưu" : "Lưu trạng thái"}
        </button>
        {page === "home" ? <div className="kc-home-header-meta"><span>{savedAt && !Number.isNaN(savedAt.getTime()) ? `Lưu ${savedAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}` : "Chưa có lần lưu"}</span><span><Check size={12} /> Dữ liệu cục bộ</span><button type="button" className={textWorkerConnected ? "is-connected" : "is-disconnected"} title="Mở cài đặt kết nối" onClick={() => onNavigate("settings")}>{textProviderLabel}</button><button type="button" className={imageWorkerConnected ? "is-connected" : "is-disconnected"} title="Worker tạo ảnh" onClick={() => onNavigate("settings")}>{imageProviderLabel}</button><button type="button" className={videoWorkerConnected ? "is-connected" : "is-disconnected"} title="Worker tạo video" onClick={() => onNavigate("settings")}>{videoProviderLabel}</button></div> : <button className="kc-header-continue" type="button" onClick={onContinueProject}><Play size={14} /> Tiếp tục dự án</button>}
        <div className="kc-search">
          <Search size={15} />
          <input ref={searchRef} value={query} placeholder="Tìm kiếm…" onChange={(event) => setQuery(event.target.value)} />
          <kbd>Ctrl K</kbd>
          {results.length > 0 && (
            <div className="kc-search-results">
              {results.map((result) => (
                <button key={result.id} type="button" onClick={() => { result.run(); setQuery(""); }}>
                  <span>{result.label}</span><small>{result.kind}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="kc-header-icon" type="button" title="Thông báo lỗi" onClick={() => onNavigate("queue")}>
          <Bell size={17} />{errorCount > 0 && <b>{errorCount}</b>}
        </button>
        <button className="kc-header-icon" type="button" title="Cài đặt" onClick={() => onNavigate("settings")}><Settings size={17} /></button>
        <div className="kc-user-avatar" title="Hồ sơ cục bộ"><UserRound size={17} /></div>
      </div>
    </header>
  );
}
