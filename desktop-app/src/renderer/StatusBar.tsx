import { Database, RadioTower } from "lucide-react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { TimelineSession } from "../shared/timeline";
import { WORKER_ROLES, type WorkerStatuses } from "../shared/worker-status";

function time(value: string | undefined): string {
  if (!value) return "Chưa lưu";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Chưa lưu" : date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

export function StatusBar({
  session,
  queue,
  workers,
}: {
  session: TimelineSession | null;
  queue: ProductionQueueSnapshot | null;
  workers: WorkerStatuses;
}) {
  const connectedSlots = WORKER_ROLES.reduce(
    (count, role) => count + (workers[role]?.connected ? workers[role]?.connectedCount || 1 : 0),
    0,
  );
  const queueLabel = queue?.state === "running" ? "Đang chạy" : queue?.state === "paused" ? "Tạm dừng" : queue?.state === "stopped" ? "Đã dừng" : "Rảnh";
  return (
    <footer className="kc-status-bar">
      <div><Database size={13} /><span>{session?.name || "Chưa có phiên"}</span></div>
      <div><span>Lưu gần nhất: {time(session?.savedAt)}</span><b className="is-success">Cục bộ</b></div>
      <div><RadioTower size={13} /><span>{connectedSlots} slot worker kết nối</span></div>
      <div><span>Queue: {queueLabel}</span>{queue?.queuedJobs ? <b>{queue.queuedJobs} chờ</b> : null}</div>
    </footer>
  );
}
