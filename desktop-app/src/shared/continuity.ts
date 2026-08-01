import type { Scene, TimelineSession } from "./timeline";

export const VIDEO_PROMPT_SECTION_LABELS = [
  "STARTING STATE:",
  "PRIMARY MOTION:",
  "REACTION:",
  "ENVIRONMENTAL MOTION:",
  "CAMERA MOTION:",
  "END FRAME:",
] as const;

export type VideoPromptSectionLabel = (typeof VIDEO_PROMPT_SECTION_LABELS)[number];
export type ContinuitySeverity = "info" | "warning" | "blocking";
export type StartingFrameSource = "generated-image" | "previous-scene-final-frame" | "manual-frame";

export interface ContinuityWarning {
  severity: ContinuitySeverity;
  code: string;
  message: string;
  field?: string;
}

export interface VideoPromptSections {
  startingState: string;
  primaryMotion: string;
  reaction: string;
  environmentalMotion: string;
  cameraMotion: string;
  endFrame: string;
  missingLabels: string[];
  duplicateLabels: string[];
  ordered: boolean;
}

export interface ContinuityValidationOptions {
  previousFinalFramePath?: string;
  noReadableText?: boolean;
  promptLengthLimit?: number;
}

export interface FlowSceneJson {
  sceneId: string;
  sceneNumber: number;
  timeStart: string;
  timeEnd: string;
  durationSeconds: 4 | 6 | 8;
  narration: string;
  visualPurpose: string;
  chainId: string;
  chainRole: "single" | "start" | "continue";
  characterIds: string[];
  environmentId: string;
  propIds: string[];
  referenceImageIds: string[];
  startingFrameSource: StartingFrameSource;
  startingState: string;
  primaryMotion: string;
  reaction: string;
  environmentalMotion: string;
  cameraMotion: string;
  endFrame: string;
  imagePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
  continuityWarnings: ContinuityWarning[];
  status: "draft" | "ready" | "submitted" | "generating" | "completed" | "rejected" | "needs_review" | "continuity_error";
}

const DEFAULT_NEGATIVE_PROMPT = [
  "readable text",
  "subtitles",
  "captions",
  "logos",
  "watermarks",
  "signatures",
  "UI overlays",
  "unmotivated character redesign",
  "wardrobe changes without story cause",
  "camera cuts inside a connected clip",
  "extra characters not present in the starting frame",
].join(", ");

function fieldText(scene: Scene, field: keyof Scene): string {
  const value = scene[field];
  return typeof value === "string" ? value.trim() : "";
}

function arrayField(scene: Scene, field: keyof Scene): string[] {
  const value = scene[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function labelKey(label: VideoPromptSectionLabel): keyof Omit<VideoPromptSections, "missingLabels" | "duplicateLabels" | "ordered"> {
  switch (label) {
    case "STARTING STATE:":
      return "startingState";
    case "PRIMARY MOTION:":
      return "primaryMotion";
    case "REACTION:":
      return "reaction";
    case "ENVIRONMENTAL MOTION:":
      return "environmentalMotion";
    case "CAMERA MOTION:":
      return "cameraMotion";
    case "END FRAME:":
      return "endFrame";
  }
}

export function extractVideoPromptSections(prompt: string): VideoPromptSections {
  const source = String(prompt || "");
  const upper = source.toUpperCase();
  const positions = VIDEO_PROMPT_SECTION_LABELS.map((label) => {
    const labelUpper = label.toUpperCase();
    const matches = [...upper.matchAll(new RegExp(labelUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
    return {
      label,
      firstIndex: matches[0]?.index ?? -1,
      count: matches.length,
    };
  });
  const result: VideoPromptSections = {
    startingState: "",
    primaryMotion: "",
    reaction: "",
    environmentalMotion: "",
    cameraMotion: "",
    endFrame: "",
    missingLabels: positions.filter((entry) => entry.firstIndex < 0).map((entry) => entry.label),
    duplicateLabels: positions.filter((entry) => entry.count > 1).map((entry) => entry.label),
    ordered: positions.every((entry, index) =>
      entry.firstIndex >= 0 && (index === 0 || entry.firstIndex > positions[index - 1].firstIndex),
    ),
  };

  for (const [index, entry] of positions.entries()) {
    if (entry.firstIndex < 0) continue;
    const next = positions.slice(index + 1).find((candidate) => candidate.firstIndex > entry.firstIndex);
    const start = entry.firstIndex + entry.label.length;
    const end = next?.firstIndex ?? source.length;
    result[labelKey(entry.label)] = source.slice(start, end).trim();
  }
  return result;
}

function hasReadableTextRequest(prompt: string): boolean {
  return /\b(readable text|subtitle|subtitles|caption|captions|logo|logos|watermark|watermarks|words on|text on screen|sign says|written on|lettering)\b/i.test(prompt);
}

function normalizedDirection(value: string): "left-to-right" | "right-to-left" | "" {
  const text = value.toLocaleLowerCase("en-US");
  if (/left\s*(?:-|to|\s)+right|screen\s+right|moves?\s+right|facing\s+right/.test(text)) return "left-to-right";
  if (/right\s*(?:-|to|\s)+left|screen\s+left|moves?\s+left|facing\s+left/.test(text)) return "right-to-left";
  return "";
}

function countActionConnectors(text: string): number {
  const matches = text.match(/\b(?:then|while|as|and|after|before|meanwhile)\b/gi);
  return matches?.length || 0;
}

export function validateContinuityScene(
  scene: Scene,
  previousScene: Scene | null,
  options: ContinuityValidationOptions = {},
): ContinuityWarning[] {
  const warnings: ContinuityWarning[] = [...(scene.continuityWarnings || [])];
  const sections = extractVideoPromptSections(scene.videoPrompt);
  const noReadableText = options.noReadableText ?? true;
  const promptLengthLimit = options.promptLengthLimit ?? 20_000;
  const promptText = `${scene.imagePrompt}\n${scene.videoPrompt}\n${fieldText(scene, "negativePrompt")}`;
  const continuationFramePath = options.previousFinalFramePath?.trim() ||
    scene.actualContinuityFrame?.path?.trim() ||
    previousScene?.actualContinuityFrame?.path?.trim() ||
    "";

  if (![4, 6, 8].includes(scene.durationSeconds)) {
    warnings.push({
      severity: "blocking",
      code: "unsupported_duration",
      field: "durationSeconds",
      message: "Scene duration must be exactly 4, 6, or 8 seconds.",
    });
  }
  if (!scene.videoPrompt.trim()) {
    warnings.push({
      severity: "blocking",
      code: "missing_video_prompt",
      field: "videoPrompt",
      message: "Every scene needs a video prompt.",
    });
  }
  if (sections.missingLabels.length || sections.duplicateLabels.length || !sections.ordered) {
    warnings.push({
      severity: "blocking",
      code: "video_prompt_sections_invalid",
      field: "videoPrompt",
      message: `Video prompt must use each required section label exactly once in order. Missing: ${sections.missingLabels.join(", ") || "none"}. Duplicate: ${sections.duplicateLabels.join(", ") || "none"}.`,
    });
  }
  if ((scene.imagePrompt.length + scene.videoPrompt.length) > promptLengthLimit) {
    warnings.push({
      severity: "warning",
      code: "prompt_too_long",
      message: `Combined prompt length exceeds ${promptLengthLimit} characters.`,
    });
  }

  if (scene.chainRole === "continue") {
    if (scene.imagePrompt.trim()) {
      warnings.push({
        severity: "blocking",
        code: "continue_has_image_prompt",
        field: "imagePrompt",
        message: "Continue scenes must leave imagePrompt empty and use the previous extracted final frame.",
      });
    }
    if (!previousScene || previousScene.chainId !== scene.chainId || previousScene.chainRole === "single") {
      warnings.push({
        severity: "blocking",
        code: "continue_chain_break",
        field: "chainId",
        message: "Continue scenes must directly follow a start/continue scene with the same chainId.",
      });
    }
    if (!continuationFramePath) {
      warnings.push({
        severity: "blocking",
        code: "missing_previous_final_frame",
        field: "startingFrameSource",
        message: "Continue scenes cannot be generated until the previous video has an extracted final frame.",
      });
    }
    if (!/supplied|reference frame|start frame|starting frame|previous final frame|actual frame/i.test(sections.startingState)) {
      warnings.push({
        severity: "warning",
        code: "continue_starting_state_not_frame_locked",
        field: "startingState",
        message: "Continue prompt should explicitly treat the supplied previous final frame as authoritative.",
      });
    }
    const previousDirection = normalizedDirection(previousScene?.plannedContinuityOut?.screenDirection || "");
    const currentDirection = normalizedDirection(`${sections.startingState} ${sections.primaryMotion} ${scene.plannedContinuityOut?.screenDirection || ""}`);
    if (previousDirection && currentDirection && previousDirection !== currentDirection) {
      warnings.push({
        severity: "warning",
        code: "screen_direction_reversal",
        field: "primaryMotion",
        message: "Screen direction appears to reverse between connected clips without an explicit turn.",
      });
    }
  } else if (!scene.imagePrompt.trim()) {
    warnings.push({
      severity: "blocking",
      code: "missing_image_prompt",
      field: "imagePrompt",
      message: "Single/start scenes need an image prompt for their opening frame.",
    });
  }

  if (!sections.endFrame && !fieldText(scene, "endFrame")) {
    warnings.push({
      severity: "blocking",
      code: "missing_end_frame",
      field: "endFrame",
      message: "Every scene must end with a precise END FRAME description.",
    });
  }
  if (noReadableText && hasReadableTextRequest(promptText)) {
    warnings.push({
      severity: "warning",
      code: "readable_text_requested",
      message: "Prompt appears to request readable text, captions, logos, or watermarks.",
    });
  }
  if (scene.durationSeconds === 4 && countActionConnectors(sections.primaryMotion) > 3) {
    warnings.push({
      severity: "warning",
      code: "motion_budget_exceeded",
      field: "primaryMotion",
      message: "A 4-second clip should contain one main action and one small reaction.",
    });
  }
  if (scene.durationSeconds === 6 && countActionConnectors(sections.primaryMotion) > 5) {
    warnings.push({
      severity: "warning",
      code: "motion_budget_exceeded",
      field: "primaryMotion",
      message: "A 6-second clip should avoid stacking multiple unrelated actions.",
    });
  }

  return dedupeWarnings(warnings);
}

function dedupeWarnings(warnings: ContinuityWarning[]): ContinuityWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.severity}:${warning.code}:${warning.field || ""}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generationStatus(scene: Scene, warnings: ContinuityWarning[]): FlowSceneJson["status"] {
  if (warnings.some((warning) => warning.severity === "blocking")) return "continuity_error";
  if (scene.videoApproved || scene.videoStatus === "done" || scene.videoResultPath) return "completed";
  if (scene.videoStatus === "generating" || scene.imageStatus === "generating") return "generating";
  if (scene.videoStatus === "submitted" || scene.videoStatus === "queued" || scene.imageStatus === "queued") return "submitted";
  if (scene.videoStatus === "error" || scene.imageStatus === "error") return "rejected";
  if (scene.imageStatus === "review" || scene.videoStatus === "review") return "needs_review";
  if (scene.imagePrompt || scene.videoPrompt) return "ready";
  return "draft";
}

export function buildFlowSceneJson(
  scene: Scene,
  previousScene: Scene | null,
  options: ContinuityValidationOptions = {},
): FlowSceneJson {
  const sections = extractVideoPromptSections(scene.videoPrompt);
  const warnings = validateContinuityScene(scene, previousScene, options);
  const startingFrameSource = fieldText(scene, "startingFrameSource") as StartingFrameSource || (
    scene.chainRole === "continue" ? "previous-scene-final-frame" : "generated-image"
  );
  const negativePrompt = fieldText(scene, "negativePrompt") || DEFAULT_NEGATIVE_PROMPT;
  return {
    sceneId: scene.id,
    sceneNumber: scene.order,
    timeStart: scene.timeStart,
    timeEnd: scene.timeEnd,
    durationSeconds: scene.durationSeconds,
    narration: fieldText(scene, "narration") || scene.beatSummary || "",
    visualPurpose: fieldText(scene, "visualPurpose") || scene.beatSummary || "",
    chainId: scene.chainId || "",
    chainRole: scene.chainRole,
    characterIds: scene.assignedCharacterTokens.length ? scene.assignedCharacterTokens : scene.usedCharacterTokens,
    environmentId: fieldText(scene, "environmentId"),
    propIds: arrayField(scene, "propIds"),
    referenceImageIds: arrayField(scene, "referenceImageIds"),
    startingFrameSource,
    startingState: fieldText(scene, "startingState") || sections.startingState,
    primaryMotion: fieldText(scene, "primaryMotion") || sections.primaryMotion,
    reaction: fieldText(scene, "reaction") || sections.reaction,
    environmentalMotion: fieldText(scene, "environmentalMotion") || sections.environmentalMotion,
    cameraMotion: fieldText(scene, "cameraMotion") || sections.cameraMotion,
    endFrame: fieldText(scene, "endFrame") || sections.endFrame,
    imagePrompt: scene.chainRole === "continue" ? "" : scene.imagePrompt,
    videoPrompt: scene.videoPrompt,
    negativePrompt,
    continuityWarnings: warnings,
    status: generationStatus(scene, warnings),
  };
}

export function buildFlowSceneJsonList(session: TimelineSession): FlowSceneJson[] {
  return session.scenes.map((scene, index, scenes) =>
    buildFlowSceneJson(scene, scenes[index - 1] || null, {
      previousFinalFramePath: scene.chainRole === "continue"
        ? scene.actualContinuityFrame?.path || scenes[index - 1]?.actualContinuityFrame?.path
        : "",
    }),
  );
}

export function buildGoogleFlowTextExport(session: TimelineSession): string {
  return buildFlowSceneJsonList(session).map((scene) => [
    `SCENE ${String(scene.sceneNumber).padStart(3, "0")}`,
    `TIME: ${scene.timeStart} --> ${scene.timeEnd}`,
    `DURATION: ${scene.durationSeconds} seconds`,
    `CHAIN ROLE: ${scene.chainRole}`,
    "",
    "IMAGE PROMPT:",
    scene.imagePrompt || "(continue scene: use previous scene final frame)",
    "",
    "VIDEO PROMPT:",
    scene.videoPrompt,
    "",
    "NEGATIVE PROMPT:",
    scene.negativePrompt,
    "",
    "REFERENCE FILES:",
    scene.referenceImageIds.concat(scene.characterIds).join(", ") || "(none assigned)",
    "",
    "CONTINUITY WARNINGS:",
    scene.continuityWarnings.map((warning) => `${warning.severity.toUpperCase()} ${warning.code}: ${warning.message}`).join("\n") || "(none)",
  ].join("\n")).join("\n\n");
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function buildGoogleFlowCsvExport(session: TimelineSession): string {
  const rows = buildFlowSceneJsonList(session);
  const header = [
    "sceneId",
    "sceneNumber",
    "timeStart",
    "timeEnd",
    "durationSeconds",
    "chainId",
    "chainRole",
    "startingFrameSource",
    "status",
    "characterIds",
    "imagePrompt",
    "videoPrompt",
    "negativePrompt",
    "blockingWarnings",
  ];
  return [
    header.map(csvCell).join(","),
    ...rows.map((scene) => [
      scene.sceneId,
      scene.sceneNumber,
      scene.timeStart,
      scene.timeEnd,
      scene.durationSeconds,
      scene.chainId,
      scene.chainRole,
      scene.startingFrameSource,
      scene.status,
      scene.characterIds.join(" "),
      scene.imagePrompt,
      scene.videoPrompt,
      scene.negativePrompt,
      scene.continuityWarnings.filter((warning) => warning.severity === "blocking").map((warning) => warning.code).join(" "),
    ].map(csvCell).join(",")),
  ].join("\n");
}

export function buildGoogleFlowSrtExport(session: TimelineSession): string {
  return buildFlowSceneJsonList(session).map((scene) => [
    String(scene.sceneNumber),
    `${scene.timeStart} --> ${scene.timeEnd}`,
    scene.visualPurpose || scene.narration || `Scene ${scene.sceneNumber}`,
  ].join("\n")).join("\n\n");
}

export function buildGoogleFlowMarkdownExport(session: TimelineSession): string {
  const scenes = buildFlowSceneJsonList(session);
  return [
    `# ${session.name}`,
    "",
    `Scenes: ${scenes.length}`,
    `Saved: ${session.savedAt}`,
    "",
    "## Visual Bible",
    "",
    `Style: ${session.visualBible.style || "(empty)"}`,
    `Palette: ${session.visualBible.palette || "(empty)"}`,
    `Lighting: ${session.visualBible.lighting || "(empty)"}`,
    `Continuity: ${session.visualBible.continuityNotes || "(empty)"}`,
    "",
    ...scenes.flatMap((scene) => [
      `## Scene ${String(scene.sceneNumber).padStart(3, "0")}`,
      "",
      `Time: ${scene.timeStart} --> ${scene.timeEnd}`,
      `Duration: ${scene.durationSeconds} seconds`,
      `Chain: ${scene.chainRole}${scene.chainId ? ` (${scene.chainId})` : ""}`,
      `Starting frame: ${scene.startingFrameSource}`,
      "",
      "### Image Prompt",
      "",
      scene.imagePrompt || "(continue scene: use previous scene final frame)",
      "",
      "### Video Prompt",
      "",
      scene.videoPrompt,
      "",
      "### Negative Prompt",
      "",
      scene.negativePrompt,
      "",
    ]),
  ].join("\n");
}
