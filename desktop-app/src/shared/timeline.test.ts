import assert from "node:assert/strict";
import test from "node:test";
import {
  connectScenesAsMovieChain,
  isImportedVoiceAudioSource,
  normalizeStoredScenes,
  normalizeTimelineWorkflowSource,
  normalizeTimelineResult,
  recalculateScenePlanning,
  shouldConnectScenesAsMovieChain,
  validateTimelineCoverage,
} from "./timeline";

test("normalizes generated scenes and character tokens", () => {
  const result = normalizeTimelineResult({
    visualBible: {
      style: "cinematic illustration",
      palette: "teal and gold",
      lighting: "soft sunset",
      continuityNotes: "Keep character proportions unchanged",
      aspectRatio: "16:9",
    },
    scenes: [
      {
        id: "ignored",
        order: 99,
        timeStart: "00:00:00,000",
        timeEnd: "00:00:08,000",
        imagePrompt: "Portrait of @ancestor and @GUIDE",
        videoPrompt: "Slow push in",
        usedCharacterTokens: ["ancestor", "@ANCESTOR"],
        policyFlag: null,
        policyResolution: {
          originalFlag: "real_person",
          status: "auto_rewritten",
          rewrittenMedia: ["image", "video"],
          resolvedAt: "2026-07-21T00:00:00.000Z",
        },
      },
    ],
  });

  assert.equal(result.scenes[0].id, "scene-001");
  assert.equal(result.scenes[0].order, 1);
  assert.equal(
    result.scenes[0].imagePrompt,
    "Portrait of @ANCESTOR and @GUIDE",
  );
  assert.deepEqual(result.scenes[0].usedCharacterTokens, [
    "@ANCESTOR",
    "@GUIDE",
  ]);
  assert.equal(result.scenes[0].imageStatus, "pending");
  assert.equal(result.visualBible.style, "cinematic illustration");
  assert.equal(result.scenes[0].characterPolicy, "selected");
  assert.deepEqual(result.scenes[0].assignedCharacterTokens, [
    "@ANCESTOR",
    "@GUIDE",
  ]);
  assert.equal(result.scenes[0].durationSeconds, 8);
  assert.equal(result.scenes[0].chainRole, "single");
  assert.equal(result.scenes[0].chainId, null);
  assert.equal(result.scenes[0].policyResolution?.status, "auto_rewritten");
  assert.deepEqual(result.scenes[0].policyResolution?.rewrittenMedia, ["image", "video"]);
});

test("rejects empty or malformed scene results", () => {
  assert.throws(() => normalizeTimelineResult({ scenes: [] }));
  assert.throws(() =>
    normalizeTimelineResult({
      scenes: [{ timeStart: "00:00:00,000", timeEnd: "00:00:01,000" }],
    }),
  );
});

test("enforces continuous 4, 6, or 8-second scene boundaries", () => {
  const scene = {
    imagePrompt: "A visible action",
    videoPrompt: "A moving camera",
  };
  const result = normalizeTimelineResult({
    scenes: [
      { ...scene, timeStart: "00:00:00", timeEnd: "00:00:04", durationSeconds: 4 },
      { ...scene, timeStart: "00:00:04", timeEnd: "00:00:10", durationSeconds: 6 },
      { ...scene, timeStart: "00:00:10", timeEnd: "00:00:18", durationSeconds: 8 },
    ],
  });
  assert.deepEqual(result.scenes.map((entry) => entry.durationSeconds), [4, 6, 8]);
  assert.throws(() => normalizeTimelineResult({
    scenes: [{ ...scene, timeStart: "00:00:00", timeEnd: "00:00:05", durationSeconds: 4 }],
  }), /boundary must match|must be 4, 6, or 8/);
  assert.throws(
    () =>
      normalizeTimelineResult({
        scenes: [
          { ...scene, timeStart: "00:00:00", timeEnd: "00:00:08" },
          { ...scene, timeStart: "00:00:09", timeEnd: "00:00:17" },
        ],
      }),
    /start exactly/,
  );
});

test("validates chain continuity and recalculates boundaries after manual duration edits", () => {
  const result = normalizeTimelineResult({
    scenes: [
      {
        timeStart: "00:00:00",
        timeEnd: "00:00:08",
        durationSeconds: 8,
        chainId: "walk-1",
        chainRole: "start",
        imagePrompt: "The walk begins",
        videoPrompt: "Camera follows",
      },
      {
        timeStart: "00:00:08",
        timeEnd: "00:00:14",
        durationSeconds: 6,
        chainId: "walk-1",
        chainRole: "continue",
        videoPrompt: "Camera follows",
      },
    ],
  });
  assert.equal(result.scenes[1].imagePrompt, "");
  const edited = recalculateScenePlanning(result.scenes, "scene-001", {
    durationSeconds: 4,
  });
  assert.equal(edited[0].timeEnd, "00:00:04,000");
  assert.equal(edited[1].timeStart, "00:00:04,000");
  assert.equal(edited[1].timeEnd, "00:00:10,000");
  const detached = recalculateScenePlanning(edited, "scene-001", { chainRole: "single" });
  assert.equal(detached[0].chainRole, "single");
  assert.equal(detached[1].chainRole, "start");
  assert.throws(() => normalizeStoredScenes(detached), /imagePrompt/);
  assert.throws(() => normalizeTimelineResult({
    scenes: [{
      timeStart: "00:00:00",
      timeEnd: "00:00:04",
      durationSeconds: 4,
      chainId: "walk-1",
      chainRole: "continue",
      imagePrompt: "Invalid continuation",
      videoPrompt: "Invalid continuation",
    }],
  }), /continue must follow/);
});

test("connects standalone scenes as one movie chain", () => {
  const result = normalizeTimelineResult({
    scenes: [
      {
        timeStart: "00:00:00",
        timeEnd: "00:00:04",
        durationSeconds: 4,
        imagePrompt: "First image",
        videoPrompt: "First video",
      },
      {
        timeStart: "00:00:04",
        timeEnd: "00:00:08",
        durationSeconds: 4,
        imagePrompt: "Second image",
        videoPrompt: "Second video",
      },
    ],
  });
  assert.equal(shouldConnectScenesAsMovieChain(result.scenes), true);
  const connected = connectScenesAsMovieChain(result.scenes, "movie-session");
  assert.equal(connected[0].chainRole, "start");
  assert.equal(connected[0].chainId, "movie-session");
  assert.equal(connected[1].chainRole, "continue");
  assert.equal(connected[1].chainId, "movie-session");
  assert.equal(connected[1].startingFrameSource, "previous-scene-final-frame");
  assert.equal(connected[1].imagePrompt, "");
  assert.equal(connected[1].imageApproved, false);
});

test("allows empty image prompts only for direct text-to-video timelines", () => {
  const source = {
    scenes: [{
      timeStart: "00:00:00",
      timeEnd: "00:00:08",
      durationSeconds: 8,
      imagePrompt: "",
      videoPrompt: "STARTING STATE: A quiet room is visible. PRIMARY MOTION: The camera moves in slowly. REACTION: No visible character reaction; the environment remains visually unchanged. ENVIRONMENTAL MOTION: Dust crosses the light. CAMERA MOTION: Slow push forward. END FRAME: The camera settles on the doorway.",
    }],
  };
  assert.throws(() => normalizeTimelineResult(source), /imagePrompt/);
  const result = normalizeTimelineResult(source, { allowEmptyImagePrompts: true });
  assert.equal(result.scenes[0].imagePrompt, "");
  assert.match(result.scenes[0].videoPrompt, /STARTING STATE/);
});

test("requires complete coverage of the SRT bounds", () => {
  const result = normalizeTimelineResult({
    scenes: [
      {
        timeStart: "00:00:02",
        timeEnd: "00:00:10",
        imagePrompt: "A visible action",
        videoPrompt: "A moving camera",
      },
    ],
  });
  assert.doesNotThrow(() =>
    validateTimelineCoverage(
      result,
      "1\n00:00:02,000 --> 00:00:09,000\nSubtitle",
    ),
  );
  assert.throws(
    () =>
      validateTimelineCoverage(
        result,
        "1\n00:00:00,000 --> 00:00:09,000\nSubtitle",
      ),
    /first SRT timestamp/,
  );
});

test("normalizes voice provider separately from imported audio source", () => {
  const capcutSource = normalizeTimelineWorkflowSource({
    narrationText: "A short narration",
    voiceName: "capcut-web-default",
    voiceProvider: "capcut-web",
  });
  assert.equal(capcutSource.audioSource, "generated");
  assert.equal(capcutSource.voiceProvider, "capcut-web");
  assert.equal(isImportedVoiceAudioSource(capcutSource), false);

  const importedSource = normalizeTimelineWorkflowSource({
    audioPath: "C:/voice.mp3",
    audioFileName: "voice.mp3",
    voiceProvider: "imported",
    srtText: "1\n00:00:00,000 --> 00:00:01,000\nHello",
    scriptText: "Hello",
  });
  assert.equal(importedSource.audioSource, "imported");
  assert.equal(importedSource.voiceProvider, "imported");
  assert.equal(isImportedVoiceAudioSource(importedSource), true);
});

test("restores completed results and resets interrupted scene jobs", () => {
  const base = {
    timeStart: "00:00:00",
    timeEnd: "00:00:08",
    imagePrompt: "Saved image prompt",
    videoPrompt: "Saved video prompt",
    usedCharacterTokens: [],
  };
  const [scene] = normalizeStoredScenes([
    {
      ...base,
      imageStatus: "done",
      imageResultPath: "mock://saved/image",
      imageFlowAssetKey: "path:https://flow.google/assets/saved-image",
      imageApproved: false,
      videoStatus: "generating",
      videoResultPath: "",
      videoApproved: false,
    },
  ]);

  assert.equal(scene.imageStatus, "done");
  assert.equal(scene.imageResultPath, "mock://saved/image");
  assert.equal(scene.imageFlowAssetKey, "path:https://flow.google/assets/saved-image");
  assert.equal(scene.videoStatus, "pending");
});

test("keeps explicit no-character policy independent from prompt tokens", () => {
  const [scene] = normalizeStoredScenes([{
    timeStart: "00:00:00",
    timeEnd: "00:00:08",
    imagePrompt: "A mural labeled @HERO",
    videoPrompt: "",
    characterPolicy: "none",
    assignedCharacterTokens: [],
  }]);

  assert.deepEqual(scene.usedCharacterTokens, ["@HERO"]);
  assert.equal(scene.characterPolicy, "none");
  assert.deepEqual(scene.assignedCharacterTokens, []);
});
