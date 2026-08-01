import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export function HomeDialog({
  title,
  description,
  children,
  confirmLabel,
  tone = "primary",
  busy = false,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onCancel]);
  return (
    <div className="kc-home-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="kc-home-dialog" role="dialog" aria-modal="true" aria-labelledby="kc-home-dialog-title">
        <header><div><h3 id="kc-home-dialog-title">{title}</h3><p>{description}</p></div><button type="button" aria-label="Đóng" disabled={busy} onClick={onCancel}><X size={16} /></button></header>
        {children && <div className="kc-home-dialog-body">{children}</div>}
        <footer><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>Hủy</button><button className={`button ${tone}`} type="button" disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "Đang xử lý…" : confirmLabel}</button></footer>
      </section>
    </div>
  );
}
