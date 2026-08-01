import { useMemo } from "react";
import type { CharacterView } from "../shared/character";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type {
  ImageGenerationProvider,
  SceneMediaType,
  VideoGenerationProvider,
} from "../shared/scene-job";
import type { Scene, TimelineVideoSourceMode } from "../shared/timeline";
import { SceneDependencyTimeline } from "./SceneDependencyTimeline";
import { WorkflowControlBar } from "./WorkflowControlBar";
import { WorkflowHeader } from "./WorkflowHeader";
import { WorkflowSceneDetail, type WorkflowSceneDetailActions } from "./WorkflowSceneDetail";
import { WorkflowSceneList } from "./WorkflowSceneList";
import { buildWorkflowSceneViews } from "./workflow-scene-view";

export interface WorkflowDashboardActions extends WorkflowSceneDetailActions {
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
  onAutoApproveChange: (enabled: boolean) => void;
  onVideoAutoApproveChange: (enabled: boolean) => void;
  onImageProviderChange: (provider: ImageGenerationProvider) => void;
  onVideoProviderChange: (provider: VideoGenerationProvider) => void;
}

export function WorkflowDashboard({
  sessionName,
  scenes,
  snapshot,
  thumbnails,
  characters,
  selectedSceneId,
  videoSourceMode,
  imageConnected,
  videoConnected,
  imageProviderLabel,
  videoProviderLabel,
  busy,
  actions,
}: {
  sessionName: string;
  scenes: Scene[];
  snapshot: ProductionQueueSnapshot | null;
  thumbnails: Record<string, string>;
  characters: CharacterView[];
  selectedSceneId: string;
  videoSourceMode?: TimelineVideoSourceMode;
  imageConnected: boolean;
  videoConnected: boolean;
  imageProviderLabel: string;
  videoProviderLabel: string;
  busy: boolean;
  actions: WorkflowDashboardActions;
}) {
  const sceneViews = useMemo(
    () => buildWorkflowSceneViews(scenes, snapshot, thumbnails, { videoSourceMode }),
    [scenes, snapshot, thumbnails, videoSourceMode],
  );
  const directVideo = videoSourceMode === "direct";
  const selected = sceneViews.find((item) => item.scene.id === selectedSceneId) || sceneViews[0] || null;
  const regenerate = (sceneId: string, mediaType: SceneMediaType) => actions.onRegenerate(sceneId, mediaType);

  return (
    <section className="workflow-dashboard" aria-label="Quản lý workflow scene">
      <WorkflowHeader sessionName={sessionName} scenes={sceneViews} snapshot={snapshot} imageConnected={imageConnected} videoConnected={videoConnected} directVideo={directVideo} onAutoApproveChange={actions.onAutoApproveChange} onVideoAutoApproveChange={actions.onVideoAutoApproveChange} />
      <WorkflowControlBar scenes={sceneViews} snapshot={snapshot} imageConnected={imageConnected} videoConnected={videoConnected} directVideo={directVideo} imageProviderLabel={imageProviderLabel} videoProviderLabel={videoProviderLabel} busy={busy} onStart={actions.onStart} onGenerateImages={actions.onGenerateImages} onGenerateVideos={actions.onGenerateVideos} onGenerateDirectVideos={actions.onGenerateDirectVideos} onCollectSubmittedVideos={actions.onCollectSubmittedVideos} onPause={actions.onPause} onResume={actions.onResume} onStop={actions.onStop} onRetryErrors={actions.onRetryErrors} onClearResults={actions.onClearResults} onBuildVideo={actions.onBuildVideo} onRefresh={actions.onRefresh} onImageProviderChange={actions.onImageProviderChange} onVideoProviderChange={actions.onVideoProviderChange} />
      <SceneDependencyTimeline scenes={sceneViews} snapshot={snapshot} selectedSceneId={selected?.scene.id || ""} directVideo={directVideo} onSelect={actions.onSelect} onRetry={actions.onResumeFrom} onOpenFolder={actions.onOpenFolder} />
      <div className="workflow-dashboard-main">
        <WorkflowSceneList scenes={sceneViews} selectedSceneId={selected?.scene.id || ""} directVideo={directVideo} onSelect={actions.onSelect} onRegenerate={regenerate} onClear={actions.onClear} onRefresh={actions.onRefresh} />
        <WorkflowSceneDetail item={selected} allScenes={sceneViews} characters={characters} directVideo={directVideo} actions={actions} />
      </div>
    </section>
  );
}
