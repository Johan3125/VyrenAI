import { AlertTriangle, Check, Circle, Clock3, LoaderCircle, Send, XCircle } from "lucide-react";
import { memo } from "react";
import { WORKFLOW_STATUS_LABELS, type WorkflowAssetStatus } from "./workflow-scene-view";

const STATUS_ICONS = {
  idle: Circle,
  waiting: Clock3,
  submitted: Send,
  processing: LoaderCircle,
  completed: Check,
  approved: Check,
  rejected: XCircle,
  error: XCircle,
  missing: AlertTriangle,
} satisfies Record<WorkflowAssetStatus, typeof Circle>;

export const WorkflowStatusBadge = memo(function WorkflowStatusBadge({
  status,
  label,
  compact = false,
}: {
  status: WorkflowAssetStatus;
  label?: string;
  compact?: boolean;
}) {
  const Icon = STATUS_ICONS[status];
  return (
    <span className={`workflow-status-badge is-${status} ${compact ? "is-compact" : ""}`}>
      <Icon className={status === "processing" ? "spin" : ""} size={compact ? 11 : 12} aria-hidden="true" />
      {label || WORKFLOW_STATUS_LABELS[status]}
    </span>
  );
});
