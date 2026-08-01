import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type {
  ChainFilterValue,
  DependencyStatus,
  PositionedDependency,
  PositionedSceneNode,
  SceneDependencyData,
  SceneGraphModel,
  SceneGraphNodeData,
  SceneGraphState,
} from "./scene-dependency-types";
import type { WorkflowSceneView } from "./workflow-scene-view";

export const SCENE_GRAPH_NODE_WIDTH = 178;
export const SCENE_GRAPH_NODE_HEIGHT = 166;
export const SCENE_GRAPH_STEP_X = 350;
export const SCENE_GRAPH_LANE_GAP = 196;

function sceneState(item: WorkflowSceneView, activeSceneId: string, directVideo = false): SceneGraphState {
  if (item.overallStatus === "error" || item.latestError) return "error";
  if (!directVideo && item.scene.chainRole === "continue" && !item.dependencyReady) return "missing";
  if (item.scene.id === activeSceneId || item.overallStatus === "processing") return "processing";
  if (item.videoStatus === "completed" || item.videoStatus === "approved") return "completed";
  return "waiting";
}

function dependencyStatus(source: WorkflowSceneView | null, target: WorkflowSceneView): DependencyStatus {
  if (!source) return "missing";
  if (target.queueScene?.startFrameAssetPath) return "ready";
  const extractJob = target.jobs.filter((job) => job.jobType === "extract_last_frame").at(-1);
  if (extractJob?.status === "running") return "extracting";
  if (extractJob?.status === "failed" || source.videoStatus === "error") return "error";
  if (extractJob?.status === "queued" || source.videoStatus === "processing" || source.videoStatus === "waiting") return "waiting";
  if (source.videoStatus === "completed" || source.videoStatus === "approved") return "missing";
  return "waiting";
}

function dependencyError(source: WorkflowSceneView | null, target: WorkflowSceneView, status: DependencyStatus): string | undefined {
  if (status === "error") return target.latestError || source?.latestError || "Không thể trích xuất frame cuối.";
  if (status === "missing") return source
    ? `Chưa có frame cuối từ Scene ${source.scene.order}.`
    : "Không tìm thấy scene nguồn cùng chain.";
  return undefined;
}

export function chainFilterOptions(scenes: WorkflowSceneView[]): Array<{ value: ChainFilterValue; label: string }> {
  const chainIds = [...new Set(scenes.map((item) => item.scene.chainId).filter((value): value is string => Boolean(value)))];
  return [
    { value: "all", label: "Tất cả chain" },
    ...chainIds.map((chainId, index) => ({ value: `chain:${chainId}` as const, label: `Chain ${index + 1} · ${chainId}` })),
    { value: "single", label: "Scene độc lập" },
    { value: "error", label: "Chain có lỗi" },
    { value: "running", label: "Chain đang chạy" },
  ];
}

function filterScenes(scenes: WorkflowSceneView[], filter: ChainFilterValue, activeSceneId: string): WorkflowSceneView[] {
  if (filter === "single") return scenes.filter((item) => item.scene.chainRole === "single");
  if (filter === "error") return scenes.filter((item) => item.overallStatus === "error" || Boolean(item.latestError) || (item.scene.chainRole === "continue" && !item.dependencyReady));
  if (filter === "running") {
    const active = scenes.find((item) => item.scene.id === activeSceneId);
    if (!active) return [];
    return active.scene.chainId
      ? scenes.filter((item) => item.scene.chainId === active.scene.chainId)
      : [active];
  }
  if (filter.startsWith("chain:")) {
    const chainId = filter.slice(6);
    return scenes.filter((item) => item.scene.chainId === chainId);
  }
  return scenes;
}

export function buildSceneGraphModel(
  scenes: WorkflowSceneView[],
  snapshot: ProductionQueueSnapshot | null,
  selectedSceneId: string,
  filter: ChainFilterValue,
  options: { directVideo?: boolean } = {},
): SceneGraphModel {
  const directVideo = options.directVideo === true;
  const activeSceneId = snapshot?.activeSceneId || "";
  const visible = filterScenes(scenes, filter, activeSceneId);
  const visibleIds = new Set(visible.map((item) => item.scene.id));
  const chainLanes = new Map<string, number>();
  let nextLane = 0;

  const nodes: PositionedSceneNode[] = visible.map((item, visibleIndex) => {
    let lane: number;
    if (filter !== "all") {
      lane = item.scene.chainRole === "single" ? 1 : 0;
    } else if (item.scene.chainRole === "single" || !item.scene.chainId) {
      lane = 2;
    } else {
      const knownLane = chainLanes.get(item.scene.chainId);
      if (knownLane === undefined) {
        lane = nextLane % 2;
        chainLanes.set(item.scene.chainId, lane);
        nextLane += 1;
      } else {
        lane = knownLane;
      }
    }
    const state = sceneState(item, activeSceneId, directVideo);
    const data: SceneGraphNodeData = {
      sceneId: item.scene.id,
      sceneNumber: item.scene.order,
      startTime: item.scene.timeStart,
      endTime: item.scene.timeEnd,
      duration: item.scene.durationSeconds,
      chainRole: item.scene.chainRole,
      chainId: item.scene.chainId,
      thumbnailUrl: item.thumbnail,
      imageStatus: item.imageStatus,
      videoStatus: item.videoStatus,
      finalFrameStatus: item.frameStatus,
      selected: item.scene.id === selectedSceneId,
      processing: state === "processing",
      blocked: state === "missing",
      state,
      errorMessage: item.latestError || undefined,
      retryMediaType: item.errors.at(-1)?.mediaType || "video",
      directVideo,
    };
    return {
      item,
      data,
      x: 34 + visibleIndex * SCENE_GRAPH_STEP_X,
      y: 24 + lane * SCENE_GRAPH_LANE_GAP,
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.data.sceneId, node]));
  const allById = new Map(scenes.map((item) => [item.scene.id, item]));
  const dependencies: PositionedDependency[] = [];

  for (let index = 0; index < scenes.length; index += 1) {
    const targetItem = scenes[index];
    if (targetItem.scene.chainRole !== "continue" || !visibleIds.has(targetItem.scene.id)) continue;
    const previousItem = scenes[index - 1] || null;
    const sourceItem = previousItem?.scene.chainId === targetItem.scene.chainId ? previousItem : null;
    const target = nodeById.get(targetItem.scene.id);
    const source = sourceItem ? nodeById.get(sourceItem.scene.id) : undefined;
    if (!target || !source) continue;
    const status: DependencyStatus = directVideo
      ? "order"
      : dependencyStatus(sourceItem ? allById.get(sourceItem.scene.id) || sourceItem : null, targetItem);
    const data: SceneDependencyData = {
      id: `${source.data.sceneId}->${target.data.sceneId}`,
      sourceSceneId: source.data.sceneId,
      sourceSceneNumber: source.data.sceneNumber,
      targetSceneId: target.data.sceneId,
      targetSceneNumber: target.data.sceneNumber,
      status,
      finalFramePath: directVideo ? undefined : targetItem.queueScene?.startFrameAssetPath || undefined,
      fileExists: directVideo ? undefined : targetItem.queueScene?.startFrameAssetPath ? undefined : false,
      errorMessage: directVideo ? undefined : dependencyError(sourceItem, targetItem, status),
    };
    dependencies.push({
      data,
      source,
      target,
      frameX: (source.x + SCENE_GRAPH_NODE_WIDTH + target.x) / 2 - 34,
      frameY: (source.y + target.y) / 2 + SCENE_GRAPH_NODE_HEIGHT / 2 - 29,
    });
  }

  const maxX = nodes.length ? Math.max(...nodes.map((node) => node.x)) : 0;
  const maxY = nodes.length ? Math.max(...nodes.map((node) => node.y)) : 0;
  return {
    nodes,
    dependencies,
    width: Math.max(720, maxX + SCENE_GRAPH_NODE_WIDTH + 50),
    height: Math.max(240, maxY + SCENE_GRAPH_NODE_HEIGHT + 42),
  };
}
