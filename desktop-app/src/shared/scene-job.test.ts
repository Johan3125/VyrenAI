import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSceneJobInput,
  normalizeSceneJobResult,
  projectOutputFolder,
} from "./scene-job";

test("normalizes matching Phase 4 scene jobs", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-104",
    mediaType: "image",
    prompt: "  A revised visible scene  ",
  });
  assert.deepEqual(input, {
    sceneId: "scene-104",
    outputFolder: "default-session",
    mediaType: "image",
    prompt: "A revised visible scene",
    characterTokens: [],
    visualBible: {
      style: "",
      palette: "",
      lighting: "",
      continuityNotes: "",
      aspectRatio: "16:9",
    },
    imageSettings: {
      provider: "google-flow",
      model: "nano-banana-pro",
      aspectRatio: "16:9",
      outputCount: 1,
      expectedCredits: 0,
    },
    sourceImagePath: "",
    sourceFlowAssetKey: "",
    startFramePath: "",
    videoSettings: {
      provider: "google-flow",
      model: "veo-3.1-lite",
      mode: "ingredients",
      delivery: "submit-only",
      aspectRatio: "16:9",
      durationSeconds: 8,
      outputCount: 1,
      expectedCredits: 0,
    },
  });
  assert.deepEqual(
    normalizeSceneJobResult(
      {
        sceneId: "scene-104",
        mediaType: "image",
        resultPath: "mock://phase4/image/scene-104/result",
        flowAssetKey: "path:https://flow.google/assets/scene-104",
      },
      input,
    ),
    {
      sceneId: "scene-104",
      mediaType: "image",
      resultPath: "mock://phase4/image/scene-104/result",
      flowAssetKey: "path:https://flow.google/assets/scene-104",
      status: "downloaded",
    },
  );
});

test("builds a stable and safe output folder for each workspace", () => {
  assert.equal(
    projectOutputFolder("session-993c45e9-e4ed-4cec-9a02-c3e7fa0bb84d", "Phiên 2"),
    "session-993c45e9-e4ed-4cec-9a02-c3e7fa0bb84d",
  );
  assert.equal(projectOutputFolder("legacy-default-project"), "session-legacy-default-project");
});

test("rejects mismatched scene results", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-001",
    mediaType: "video",
    prompt: "Camera tracks forward",
    sourceImagePath: "C:\\FlowX\\scene-001.png",
    sourceFlowAssetKey: "path:https://flow.google/assets/scene-001",
  });
  assert.throws(() =>
    normalizeSceneJobResult(
      {
        sceneId: "scene-002",
        mediaType: "video",
        resultPath: "mock://wrong",
        flowAssetKey: "",
      },
      input,
    ),
  );
});

test("normalizes Frames video settings and requires the extracted start frame", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-002",
    mediaType: "video",
    prompt: "The camera continues its slow movement",
    sourceImagePath: "C:\\FlowX\\scene-002.png",
    startFramePath: "C:\\FlowX\\scene-001-last-frame.png",
    videoSettings: {
      mode: "frames",
      durationSeconds: 4,
    },
  });
  assert.equal(input.videoSettings.mode, "frames");
  assert.equal(input.videoSettings.durationSeconds, 4);
  assert.equal(input.startFramePath, "C:\\FlowX\\scene-001-last-frame.png");
  assert.throws(() => normalizeSceneJobInput({
    sceneId: "scene-002",
    mediaType: "video",
    prompt: "The camera continues its slow movement",
    sourceImagePath: "C:\\FlowX\\scene-002.png",
    videoSettings: { mode: "frames", durationSeconds: 4 },
  }), /start frame/i);
});

test("normalizes First Frame video without requiring a separate end boundary", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-003",
    mediaType: "video",
    prompt: "The character strides forward with natural weight transfer",
    sourceImagePath: "C:\\FlowX\\scene-003.png",
    videoSettings: {
      mode: "first-frame",
      durationSeconds: 6,
    },
  });
  assert.equal(input.videoSettings.mode, "first-frame");
  assert.equal(input.videoSettings.durationSeconds, 6);
  assert.equal(input.startFramePath, "");
});

test("normalizes direct text-to-video without a completed scene image", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-004",
    mediaType: "video",
    prompt: "A slow cinematic push through the workshop as sparks drift in the air",
    sourceImagePath: "",
    videoSettings: {
      mode: "text-to-video",
      durationSeconds: 8,
    },
  });
  assert.equal(input.videoSettings.mode, "text-to-video");
  assert.equal(input.videoSettings.provider, "google-flow");
  assert.equal(input.videoSettings.model, "veo-3.1-lite");
  assert.equal(input.sourceImagePath, "");
  assert.equal(input.sourceFlowAssetKey, "");
});

test("normalizes CapCut Video Studio provider settings", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-014",
    mediaType: "video",
    prompt: "A single wide shot of the hero stepping through neon rain",
    sourceImagePath: "",
    videoSettings: {
      provider: "capcut-video",
      mode: "text-to-video",
      durationSeconds: 6,
    },
  });
  assert.equal(input.videoSettings.provider, "capcut-video");
  assert.equal(input.videoSettings.model, "capcut-video-studio-web");
  assert.equal(input.videoSettings.mode, "text-to-video");
  assert.equal(input.videoSettings.durationSeconds, 6);
});

test("normalizes explicit character assignments and the free Ultra image preset", () => {
  const input = normalizeSceneJobInput({
    sceneId: "scene-012",
    mediaType: "image",
    prompt: "Gulit waits by the window",
    characterTokens: ["gulit", "@GULIT"],
    visualBible: {
      style: " cinematic 3D ",
      palette: " teal and gold ",
      lighting: " soft sunset ",
      continuityNotes: " keep the blue coat ",
      aspectRatio: "9:16",
    },
    imageSettings: { aspectRatio: "9:16" },
  });

  assert.deepEqual(input.characterTokens, ["@GULIT"]);
  assert.equal(input.visualBible.style, "cinematic 3D");
  assert.equal(input.visualBible.aspectRatio, "16:9");
  assert.deepEqual(input.imageSettings, {
    provider: "google-flow",
    model: "nano-banana-pro",
    aspectRatio: "16:9",
    outputCount: 1,
    expectedCredits: 0,
  });
  assert.equal(input.sourceImagePath, "");
  assert.equal(input.sourceFlowAssetKey, "");
  assert.equal(input.videoSettings.model, "veo-3.1-lite");
});

test("requires a completed scene image for Ingredients to Video", () => {
  assert.throws(() => normalizeSceneJobInput({
    sceneId: "scene-002",
    mediaType: "video",
    prompt: "The character turns while the camera tracks right",
    sourceImagePath: "",
  }), /completed image/);

  const input = normalizeSceneJobInput({
    sceneId: "scene-002",
    mediaType: "video",
    prompt: "The character turns while the camera tracks right",
    sourceImagePath: "C:\\Users\\FlowX\\scene-002.webp",
    sourceFlowAssetKey: "path:https://flow.google/assets/scene-002",
  });
  assert.equal(input.sourceImagePath, "C:\\Users\\FlowX\\scene-002.webp");
  assert.equal(input.sourceFlowAssetKey, "path:https://flow.google/assets/scene-002");
  assert.deepEqual(input.videoSettings, {
    provider: "google-flow",
    model: "veo-3.1-lite",
    mode: "ingredients",
    delivery: "submit-only",
    aspectRatio: "16:9",
    durationSeconds: 8,
    outputCount: 1,
    expectedCredits: 0,
  });
});
