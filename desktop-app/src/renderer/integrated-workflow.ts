import type {
  TimelineStyleReference,
  TimelineWorkflowSource,
  VideoWorkflowMode,
  VisualBible,
} from "../shared/timeline";

export type HomeWorkflowMode = "full_auto" | "script_to_media" | "step_by_step";

export interface IntegratedWorkflowHandoff {
  id: string;
  sessionId: string;
  workflowMode: VideoWorkflowMode;
  workflowSource: TimelineWorkflowSource;
  visualBible: VisualBible;
  styleReference: TimelineStyleReference | null;
  autoGenerateTimeline: boolean;
}
