import type { SceneMediaType } from "../shared/scene-job";
import type { WorkflowAssetStatus, WorkflowSceneView } from "./workflow-scene-view";

export type DependencyStatus = "ready" | "extracting" | "waiting" | "missing" | "error" | "order" | "none";
export type SceneGraphState = "completed" | "processing" | "waiting" | "missing" | "error";

export interface SceneGraphNodeData {
  sceneId: string;
  sceneNumber: number;
  startTime: string;
  endTime: string;
  duration: 4 | 6 | 8;
  chainRole: "single" | "start" | "continue";
  chainId: string | null;
  thumbnailUrl?: string;
  imageStatus: WorkflowAssetStatus;
  videoStatus: WorkflowAssetStatus;
  finalFrameStatus: WorkflowAssetStatus;
  renderProgress?: number;
  selected: boolean;
  processing: boolean;
  blocked: boolean;
  state: SceneGraphState;
  errorMessage?: string;
  retryMediaType: SceneMediaType;
  directVideo?: boolean;
}

export interface SceneDependencyData {
  id: string;
  sourceSceneId: string;
  sourceSceneNumber: number;
  targetSceneId: string;
  targetSceneNumber: number;
  status: DependencyStatus;
  finalFramePath?: string;
  extractedAt?: string;
  updatedAt?: string;
  fileExists?: boolean;
  fileSize?: number;
  width?: number;
  height?: number;
  progress?: number;
  errorMessage?: string;
}

export interface PositionedSceneNode {
  item: WorkflowSceneView;
  data: SceneGraphNodeData;
  x: number;
  y: number;
}

export interface PositionedDependency {
  data: SceneDependencyData;
  source: PositionedSceneNode;
  target: PositionedSceneNode;
  frameX: number;
  frameY: number;
}

export interface SceneGraphModel {
  nodes: PositionedSceneNode[];
  dependencies: PositionedDependency[];
  width: number;
  height: number;
}

export type ChainFilterValue = "all" | "single" | "error" | "running" | `chain:${string}`;
