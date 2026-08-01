import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlowSceneJson,
  buildGoogleFlowTextExport,
  extractVideoPromptSections,
  validateContinuityScene,
} from "./continuity";
import { normalizeTimelineResult, type TimelineSession } from "./timeline";

const VIDEO_PROMPT = [
  "STARTING STATE:",
  "Begin from the supplied reference frame with Alex on the left side of the desk, facing right.",
  "PRIMARY MOTION:",
  "Alex lowers one hand toward the red control while keeping his body angled toward Orbit.",
  "REACTION:",
  "Orbit leans back slightly and looks at Alex.",
  "ENVIRONMENTAL MOTION:",
  "The small indicator light flickers once while the room stays still.",
  "CAMERA MOTION:",
  "Use a stable eye-level push-in without cutting.",
  "END FRAME:",
  "End with Alex's finger resting near the control and Orbit still leaning back on the right.",
].join("\n");

test("extracts required Google Flow video prompt sections", () => {
  const sections = extractVideoPromptSections(VIDEO_PROMPT);
  assert.equal(sections.missingLabels.length, 0);
  assert.equal(sections.ordered, true);
  assert.match(sections.startingState, /Alex on the left/);
  assert.match(sections.endFrame, /Orbit still leaning back/);
});

test("blocks continue scenes until a previous final frame exists", () => {
  const result = normalizeTimelineResult({
    scenes: [
      {
        timeStart: "00:00:00",
        timeEnd: "00:00:08",
        durationSeconds: 8,
        chainId: "chain-001",
        chainRole: "start",
        imagePrompt: "SUBJECT AND ACTION: Alex stands at the desk. EMOTION AND BODY LANGUAGE: alert. SETTING AND BACKGROUND: compact control room. DEPTH LAYERS: desk and wall. CAMERA AND COMPOSITION: medium shot.",
        videoPrompt: VIDEO_PROMPT,
      },
      {
        timeStart: "00:00:08",
        timeEnd: "00:00:14",
        durationSeconds: 6,
        chainId: "chain-001",
        chainRole: "continue",
        imagePrompt: "This must be discarded",
        videoPrompt: VIDEO_PROMPT,
      },
    ],
  });

  assert.equal(result.scenes[1].imagePrompt, "");
  const warnings = validateContinuityScene(result.scenes[1], result.scenes[0]);
  assert.equal(warnings.some((warning) => warning.code === "missing_previous_final_frame"), true);
  assert.equal(warnings.some((warning) => warning.severity === "blocking"), true);
});

test("accepts persisted continuation frame on the target continue scene", () => {
  const result = normalizeTimelineResult({
    scenes: [
      {
        timeStart: "00:00:00",
        timeEnd: "00:00:08",
        durationSeconds: 8,
        chainId: "chain-001",
        chainRole: "start",
        imagePrompt: "SUBJECT AND ACTION: Alex stands at the desk. EMOTION AND BODY LANGUAGE: alert. SETTING AND BACKGROUND: compact control room. DEPTH LAYERS: desk and wall. CAMERA AND COMPOSITION: medium shot.",
        videoPrompt: VIDEO_PROMPT,
      },
      {
        timeStart: "00:00:08",
        timeEnd: "00:00:14",
        durationSeconds: 6,
        chainId: "chain-001",
        chainRole: "continue",
        imagePrompt: "",
        videoPrompt: VIDEO_PROMPT,
      },
    ],
  });
  result.scenes[1].actualContinuityFrame = {
    path: "C:/Vyren AI/.kc-frames/scene-001-last-frame.png",
    fileSize: 42,
  };

  const warnings = validateContinuityScene(result.scenes[1], result.scenes[0]);
  assert.equal(warnings.some((warning) => warning.code === "missing_previous_final_frame"), false);
  assert.equal(warnings.some((warning) => warning.severity === "blocking"), false);
});

test("builds Flow-ready scene JSON and text export", () => {
  const result = normalizeTimelineResult({
    visualBible: {
      style: "locked style",
      palette: "muted cyan and warm practical lights",
      lighting: "upper-left soft key light",
      continuityNotes: "Keep wardrobe and screen direction fixed.",
      aspectRatio: "16:9",
    },
    scenes: [
      {
        timeStart: "00:00:00",
        timeEnd: "00:00:08",
        durationSeconds: 8,
        imagePrompt: "SUBJECT AND ACTION: Alex stands at the desk. EMOTION AND BODY LANGUAGE: alert. SETTING AND BACKGROUND: compact control room. DEPTH LAYERS: desk and wall. CAMERA AND COMPOSITION: medium shot.",
        videoPrompt: VIDEO_PROMPT,
        negativePrompt: "readable text, subtitles, logos, watermarks",
      },
    ],
  });
  const session: TimelineSession = {
    id: "session-test",
    name: "Test Session",
    createdAt: "2026-07-22T00:00:00.000Z",
    savedAt: "2026-07-22T00:00:00.000Z",
    scenes: result.scenes,
    visualBible: result.visualBible,
    styleReference: null,
    workflowMode: "two_step",
    workflowSource: {
      narrationText: "",
      narrationFileName: "",
      narrationPath: "",
      srtText: "",
      scriptText: "",
      srtFileName: "",
      scriptFileName: "",
      srtPath: "",
      scriptPath: "",
      audioPath: "",
      audioFileName: "",
    },
  };

  const sceneJson = buildFlowSceneJson(result.scenes[0], null);
  assert.equal(sceneJson.sceneId, "scene-001");
  assert.equal(sceneJson.startingFrameSource, "generated-image");
  assert.match(sceneJson.videoPrompt, /STARTING STATE:/);
  assert.match(buildGoogleFlowTextExport(session), /SCENE 001/);
});
