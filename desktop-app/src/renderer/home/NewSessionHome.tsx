import { Bot, CalendarDays, FileText, FolderOpen, Pencil, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import type { TimelineSession } from "../../shared/timeline";
import type { HomeWorkflowMode } from "../integrated-workflow";
import { HomeDialog } from "./HomeDialog";

const MODES: Array<{
  id: HomeWorkflowMode;
  title: string;
  description: string;
  accent: string;
  icon: typeof Bot;
}> = [
  { id: "full_auto", title: "Đồng bộ thoại", description: "Tạo voice hoặc dùng MP3/SRT có sẵn, sau đó đồng bộ hình ảnh và video theo lời thoại", accent: "success", icon: Bot },
  { id: "script_to_media", title: "Kịch bản → Media", description: "Chỉ cần nhập kịch bản; hệ thống tự lập timeline và tạo prompt, storyboard ảnh hoặc video", accent: "purple", icon: FileText },
  { id: "step_by_step", title: "Quy trình nâng cao", description: "Kiểm tra và chủ động chạy từng giai đoạn Voice, nhân vật, Visual Bible và sản xuất", accent: "warning", icon: Workflow },
];

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Chưa có dữ liệu" : parsed.toLocaleString("vi-VN");
}

export function NewSessionHome({
  session,
  onSelectMode,
  onRename,
  onOpenSessions,
  onDelete,
}: {
  session: TimelineSession | null;
  onSelectMode: (mode: HomeWorkflowMode) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onOpenSessions: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<HomeWorkflowMode | null>(null);
  const [dialog, setDialog] = useState<"mode" | "rename" | "delete" | null>(null);
  const [name, setName] = useState(session?.name || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = MODES.find((item) => item.id === mode);
  const run = async (operation: () => Promise<boolean>) => {
    setBusy(true);
    setError("");
    try {
      if (await operation()) setDialog(null);
      else setError("Không thể lưu thay đổi. Hãy kiểm tra thông báo của ứng dụng.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kc-home-new">
      <section className="kc-home-session-card">
        <div className="kc-home-session-mark"><span>VY</span></div>
        <div><small>PHIÊN HIỆN TẠI</small><h2>{session?.name || "Phiên chưa đặt tên"}</h2><p><CalendarDays size={13} /> Tạo lúc {dateLabel(session?.createdAt || "")}</p></div>
        <span className="kc-home-status is-muted">Chưa thiết lập</span>
        <div className="kc-home-session-actions">
          <button className="button secondary compact" type="button" onClick={() => { setName(session?.name || ""); setDialog("rename"); }}><Pencil size={14} /> Đổi tên</button>
          <button className="button secondary compact" type="button" onClick={onOpenSessions}><FolderOpen size={14} /> Mở phiên khác</button>
          <button className="button danger compact" type="button" onClick={() => setDialog("delete")}><Trash2 size={14} /> Xóa phiên</button>
        </div>
      </section>

      <section className="kc-home-mode-section">
        <header><div><small>CHỌN QUY TRÌNH</small><h2>Bạn muốn bắt đầu theo cách nào?</h2><p>Chế độ được lưu theo phiên và không hiển thị lại sau khi đã chọn.</p></div></header>
        <div className="kc-home-mode-cards">
          {MODES.map((item) => {
            const Icon = item.icon;
            return <article key={item.id} className={`is-${item.accent}`} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") { setMode(item.id); setDialog("mode"); } }}><span><Icon size={23} /></span><div><strong>{item.title}</strong><p>{item.description}</p></div><button type="button" onClick={() => { setMode(item.id); setDialog("mode"); }}>Chọn chế độ này</button></article>;
          })}
        </div>
      </section>

      {dialog === "mode" && selected && <HomeDialog title={`Chọn “${selected.title}”?`} description="Chế độ này sẽ được lưu cho phiên hiện tại. Sau đó Homepage chỉ hiển thị các bước cần hoàn thành." confirmLabel="Xác nhận chế độ" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => void run(() => onSelectMode(selected.id))}>{error && <p className="form-error">{error}</p>}</HomeDialog>}
      {dialog === "rename" && <HomeDialog title="Đổi tên phiên" description="Tên mới được lưu vào hồ sơ phiên hiện tại." confirmLabel="Lưu tên" busy={busy} confirmDisabled={!name.trim()} onCancel={() => setDialog(null)} onConfirm={() => void run(() => onRename(name.trim()))}><label className="field"><span>Tên phiên</span><input autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) void run(() => onRename(name.trim())); }} /></label>{error && <p className="form-error">{error}</p>}</HomeDialog>}
      {dialog === "delete" && <HomeDialog title="Xóa phiên làm việc?" description={`Phiên “${session?.name || "hiện tại"}” và liên kết timeline sẽ bị xóa. Không thể thực hiện khi workflow còn đang chạy.`} confirmLabel="Xóa phiên" tone="danger" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => void run(onDelete)}>{error && <p className="form-error">{error}</p>}</HomeDialog>}
    </div>
  );
}
