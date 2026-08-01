import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

interface Boundary {
  sceneIndex?: number;
  startMs: number;
  endMs: number;
  start?: string;
  end?: string;
  durationSeconds?: 4 | 6 | 8;
  chainId?: string | null;
  chainRole?: "single" | "start" | "continue";
  chainRisk?: "low" | "medium" | "high" | null;
  recommendedReanchor?: boolean | null;
  beatSummary?: string;
}

interface TimelineBatch {
  boundaries: Boundary[];
  srtText: string;
}

test("selects the correct text-worker adapter from the provider hostname", async () => {
  const source = await readFile(
    resolve(process.cwd(), "../extension-worker/content-chat.js"),
    "utf8",
  );
  const expected = [
    ["chatgpt.com", "chat-worker", "ChatGPT"],
    ["claude.ai", "claude-worker", "Claude"],
    ["gemini.google.com", "gemini-worker", "Gemini"],
    ["grok.com", "grok-worker", "Grok"],
  ] as const;

  for (const [hostname, role, label] of expected) {
    const windowValue: Record<string, unknown> = { location: { hostname } };
    const context = {
      window: windowValue,
      chrome: {
        runtime: {
          onMessage: { addListener: () => {} },
          sendMessage: () => Promise.resolve(),
        },
      },
      console,
      setTimeout,
      clearTimeout,
      AbortController,
      HTMLElement: class {},
      HTMLTextAreaElement: class {},
      Event: class {},
      InputEvent: class {},
    };
    vm.runInNewContext(source, context);
    const internals = windowValue.__FLOWX_CHAT_INTERNALS__ as {
      textProvider: { role: string; label: string };
    };
    assert.deepEqual(
      { ...internals.textProvider },
      { role, label },
    );
  }
});

test("splits a long SRT into batches of six 8-second scenes", async () => {
  const source = await readFile(
    resolve(process.cwd(), "../extension-worker/content-chat.js"),
    "utf8",
  );
  const windowValue: Record<string, unknown> = {};
  const context = {
    window: windowValue,
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve(),
      },
    },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    HTMLElement: class {},
    HTMLTextAreaElement: class {},
    Event: class {},
    InputEvent: class {},
  };
  vm.runInNewContext(source, context);

  const internals = windowValue.__FLOWX_CHAT_INTERNALS__ as {
    createTimelineBatches: (srtText: string) => TimelineBatch[];
    buildBeatPlanningPrompt: (
      srtText: string,
      scriptText: string,
      previousError?: string,
      hasStyleReference?: boolean,
      options?: { chainPlanning?: boolean },
    ) => string;
    parseBeatPlanningResponse: (text: string) => Array<Record<string, unknown>>;
    validateBeatPlanningResult: (
      beats: Array<Record<string, unknown>>,
      srtText: string,
      options?: { chainPlanning?: boolean },
    ) => Boundary[];
    buildTimelinePrompt: (
      batch: TimelineBatch & { index: number },
      batchCount: number,
      scriptText: string,
      visualBible?: {
        style: string;
        palette: string;
        lighting: string;
        continuityNotes: string;
        aspectRatio: "16:9";
      },
      characterRoster?: Array<{ token: string; name: string }>,
      hasStyleReference?: boolean,
    ) => string;
    buildTimelineRetryPrompt: (
      batch: TimelineBatch & { index: number },
      batchCount: number,
      reason: string,
      attempt: number,
      visualBible?: Record<string, string>,
      characterRoster?: Array<{ token: string; name: string }>,
      hasStyleReference?: boolean,
    ) => string;
    validateBatchResult: (
      result: { scenes: Array<Record<string, unknown>>; visualBible?: unknown },
      batch: TimelineBatch & { index: number },
      characterRoster?: Array<{ token: string; name: string }>,
    ) => void;
    buildPolicyRewritePrompt: (payload: Record<string, unknown>) => string;
    parsePolicyRewriteResponse: (text: string, mediaType: "image" | "video") => { prompt: string };
    buildProviderImagePrompt: (payload: Record<string, any>) => string;
    buildProviderVideoPrompt: (payload: Record<string, any>) => string;
  };
  const batches = internals.createTimelineBatches(`1
00:00:00,000 --> 00:00:04,000
Opening

2
00:03:20,000 --> 00:03:21,000
Ending`);

  assert.deepEqual(
    Array.from(batches, (batch) => batch.boundaries.length),
    [6, 6, 6, 6, 2],
  );
  assert.equal(batches[0].boundaries[0].startMs, 0);
  const finalEnd = batches[4].boundaries.at(-1)?.endMs;
  assert.equal(finalEnd, 208_000);
  assert.equal(finalEnd! - 201_000, 7_000);
  assert.match(batches[0].srtText, /Opening/);
  assert.match(batches[4].srtText, /Ending/);

  const beatSrt = `1
00:00:00,000 --> 00:00:08,000
The hero enters.

2
00:00:08,000 --> 00:00:18,000
The hero crosses the hall.`;
  const beatPrompt = internals.buildBeatPlanningPrompt(beatSrt, "A continuous walk through one hall.");
  assert.match(beatPrompt, /JOB TYPE: beat_planning/);
  assert.match(beatPrompt, /sum of durationSeconds MUST equal exactly 18 seconds/);
  assert.match(beatPrompt, /chain MUST NOT exceed 6 beats/i);
  assert.match(beatPrompt, /SRT is authoritative/i);
  const referenceBeatPrompt = internals.buildBeatPlanningPrompt(
    beatSrt,
    "A continuous walk through one hall.",
    "",
    true,
  );
  assert.match(referenceBeatPrompt, /style reference image is attached/i);
  assert.match(referenceBeatPrompt, /graphic style text is authoritative/);
  assert.match(referenceBeatPrompt, /never inject style-reference terminology into scene prompts/);
  const boundaryOnlyPrompt = internals.buildBeatPlanningPrompt(
    beatSrt,
    "A continuous walk through one hall.",
    "",
    false,
    { chainPlanning: false },
  );
  assert.match(boundaryOnlyPrompt, /BOUNDARY-ONLY MODE/);
  assert.doesNotMatch(boundaryOnlyPrompt, /CHAIN RULES/);
  assert.match(boundaryOnlyPrompt, /Do not return chainId, chainRole, chainRisk, or recommendedReanchor/);
  const boundaryOnlyPlan = internals.validateBeatPlanningResult(
    [
      { timeStart: "00:00:00,000", timeEnd: "00:00:08,000", durationSeconds: 8, beatSummary: "The hero enters." },
      { timeStart: "00:00:08,000", timeEnd: "00:00:14,000", durationSeconds: 6, beatSummary: "The hero crosses the hall." },
      { timeStart: "00:00:14,000", timeEnd: "00:00:18,000", durationSeconds: 4, beatSummary: "The action settles." },
    ],
    beatSrt,
    { chainPlanning: false },
  );
  assert.deepEqual(Array.from(boundaryOnlyPlan, (beat) => beat.chainRole), ["single", "single", "single"]);
  assert.deepEqual(Array.from(boundaryOnlyPlan, (beat) => beat.durationSeconds), [8, 6, 4]);
  const beatPlan = internals.validateBeatPlanningResult(
    internals.parseBeatPlanningResponse(JSON.stringify({ beats: [
      { timeStart: "00:00:00,000", timeEnd: "00:00:08,000", durationSeconds: 8, chainId: "hall", chainRole: "start" },
      { timeStart: "00:00:08,000", timeEnd: "00:00:14,000", durationSeconds: 6, chainId: "hall", chainRole: "continue" },
      { timeStart: "00:00:14,000", timeEnd: "00:00:18,000", durationSeconds: 4, chainId: null, chainRole: "single" },
    ] })),
    beatSrt,
  );
  assert.deepEqual(Array.from(beatPlan, (beat) => beat.durationSeconds), [8, 6, 4]);
  assert.equal(beatPlan.at(-1)?.endMs, 18_000);
  assert.equal(beatPlan[0].sceneIndex, 1);
  assert.equal(beatPlan[0].chainRisk, "low");
  const rewriteRequest = internals.buildPolicyRewritePrompt({
    sceneId: "scene-004",
    mediaType: "video",
    prompt: "Unsafe original prompt",
    policyError: "Safety policy",
    timeStart: "00:00:24,000",
    timeEnd: "00:00:32,000",
    pairedPrompt: "Opening frame context",
    visualBible: { aspectRatio: "16:9" },
    policyFlag: "real_person",
  });
  assert.match(rewriteRequest, /policy_safe_prompt_rewrite/);
  assert.match(rewriteRequest, /Do not evade, disguise, encode/);
  assert.match(rewriteRequest, /original, fictional, non-identifiable person/i);
  assert.match(rewriteRequest, /Remove the real person's name, aliases, @tokens/i);
  const safeVideoPrompt = `STARTING STATE: a worried figure pauses beside a closed doorway in a quiet hallway. PRIMARY MOTION: the figure steps backward while keeping both hands visible and turning toward a distant sound. REACTION: concern changes into alert attention through the eyes, eyebrows, head angle, and guarded posture. ENVIRONMENTAL MOTION: a loose curtain moves gently beside the window while soft dust crosses the light. CAMERA MOTION: a steady medium tracking shot follows the retreat at natural speed without sudden movement. END FRAME: the figure stops safely near the hallway corner and looks toward the unseen source.`;
  assert.equal(
    internals.parsePolicyRewriteResponse(JSON.stringify({ prompt: safeVideoPrompt }), "video").prompt,
    safeVideoPrompt,
  );
  const providerImagePrompt = internals.buildProviderImagePrompt({
    prompt: "A hero crosses a bright blue bridge.",
    visualBible: {
      style: "flat vector",
      palette: "blue and gold",
      lighting: "soft daylight",
      continuityNotes: "Keep the blue coat unchanged",
    },
    refImages: [{ token: "@HERO", name: "Hero" }],
  });
  assert.match(providerImagePrompt, /exactly one landscape 16:9 image/i);
  assert.match(providerImagePrompt, /@HERO = Hero/);
  assert.match(providerImagePrompt, /Keep the blue coat unchanged/);
  const providerVideoPrompt = internals.buildProviderVideoPrompt({
    prompt: "The hero walks forward while the camera tracks right.",
    videoSettings: { durationSeconds: 6 },
  });
  assert.match(providerVideoPrompt, /lasting 6 seconds/i);
  assert.match(providerVideoPrompt, /exact opening frame/i);
  assert.match(providerVideoPrompt, /camera tracks right/);
  assert.throws(() => internals.validateBeatPlanningResult([
    { timeStart: "00:00:00,000", timeEnd: "00:00:08,000", durationSeconds: 8, chainId: null, chainRole: "single" },
    { timeStart: "00:00:10,000", timeEnd: "00:00:18,000", durationSeconds: 8, chainId: null, chainRole: "single" },
  ], beatSrt), /gap, overlap/);

  const longChainSrt = `1
00:00:00,000 --> 00:00:28,000
A single continuous action.`;
  const sevenBeatChain = Array.from({ length: 7 }, (_, index) => ({
    timeStart: `00:00:${String(index * 4).padStart(2, "0")},000`,
    timeEnd: `00:00:${String((index + 1) * 4).padStart(2, "0")},000`,
    durationSeconds: 4,
    chainId: "too-long",
    chainRole: index === 0 ? "start" : "continue",
  }));
  assert.throws(
    () => internals.validateBeatPlanningResult(sevenBeatChain, longChainSrt),
    /hard chain cap of 6 scenes/,
  );

  const plannedBatches = (internals.createTimelineBatches as unknown as (
    srtText: string,
    boundaries: Boundary[],
  ) => TimelineBatch[])(beatSrt, beatPlan);
  assert.deepEqual(
    Array.from(plannedBatches[0].boundaries, (boundary) => boundary.durationSeconds),
    [8, 6, 4],
  );
  const chainAwareBoundaries = Array.from({ length: 10 }, (_, index): Boundary => ({
    sceneIndex: index + 1,
    startMs: index * 8_000,
    endMs: (index + 1) * 8_000,
    start: `00:00:${String(index * 8).padStart(2, "0")},000`,
    end: `00:00:${String((index + 1) * 8).padStart(2, "0")},000`,
    durationSeconds: 8,
    chainId: index >= 5 && index <= 7 ? "chain-boundary" : null,
    chainRole: index === 5 ? "start" : index === 6 || index === 7 ? "continue" : "single",
  }));
  const chainAwareBatches = (internals.createTimelineBatches as unknown as (
    srtText: string,
    boundaries: Boundary[],
  ) => TimelineBatch[])(`1
00:00:00,000 --> 00:01:20,000
Continuous source.`, chainAwareBoundaries);
  assert.deepEqual(Array.from(chainAwareBatches, (batch) => batch.boundaries.length), [5, 5]);
  assert.deepEqual(
    Array.from(chainAwareBatches[1].boundaries.slice(0, 3), (boundary) => boundary.chainRole),
    ["start", "continue", "continue"],
  );

  const complexBoundaries = chainAwareBoundaries.map((boundary, index) => ({
    ...boundary,
    chainId: index <= 3 ? "complex" : null,
    chainRole: index === 0 ? "start" as const : index <= 3 ? "continue" as const : "single" as const,
    chainRisk: index === 3 ? "high" as const : "low" as const,
  }));
  const complexBatches = (internals.createTimelineBatches as unknown as (
    srtText: string,
    boundaries: Boundary[],
  ) => TimelineBatch[])(`1
00:00:00,000 --> 00:01:20,000
Complex continuous source.`, complexBoundaries);
  assert.equal(complexBatches[0].boundaries.length, 4);
  const plannedPrompt = internals.buildTimelinePrompt(
    plannedBatches[0] as TimelineBatch & { index: number },
    plannedBatches.length,
    "A continuous walk through one hall.",
  );
  assert.match(plannedPrompt, /chainRole=continue \| chainId=hall/);
  assert.match(plannedPrompt, /For chainRole continue, write ONLY the video prompt/);
  assert.match(plannedPrompt, /imagePrompt MUST be exactly ""/);
  assert.match(plannedPrompt, /actualContinuityFrame.*runtime source of truth/i);
  assert.match(plannedPrompt, /"policyFlag":null/);
  assert.match(plannedPrompt, /"plannedContinuityOut"/);
  assert.match(plannedPrompt, /No additional foreground or background elements are required/);
  assert.match(plannedPrompt, /No visible character reaction/);
  const referencedStylePrompt = internals.buildTimelinePrompt(
    plannedBatches[0] as TimelineBatch & { index: number },
    plannedBatches.length,
    "A continuous walk through one hall.",
    {
      style: "User-locked stickman base",
      palette: "",
      lighting: "",
      continuityNotes: "",
      aspectRatio: "16:9",
    },
    [],
    true,
  );
  assert.match(referencedStylePrompt, /Copy it character-for-character/);
  assert.match(referencedStylePrompt, /creates no exception to the immutable style rule/);

  const firstPrompt = internals.buildTimelinePrompt(
    batches[0] as TimelineBatch & { index: number },
    batches.length,
    "A complete cinematic story with a recurring blue-coated hero.",
  );
  assert.match(firstPrompt, /PROJECT VISUAL BIBLE — REQUIRED/);
  assert.match(firstPrompt, /"visualBible"/);
  assert.match(firstPrompt, /complete supporting script/i);
  assert.match(firstPrompt, /aspectRatio must always be exactly "16:9"/);
  assert.match(firstPrompt, /Never invent a character/);
  assert.doesNotMatch(firstPrompt, /Stickman, flat 2D illustration/);

  const rosterPrompt = internals.buildTimelinePrompt(
    batches[0] as TimelineBatch & { index: number },
    batches.length,
    "Gullit enters and Gullit returns later.",
    undefined,
    [{ token: "@GULLIT", name: "Gullit" }],
  );
  assert.match(rosterPrompt, /Gullit = @GULLIT/);
  assert.match(rosterPrompt, /token beside the name/);
  assert.match(rosterPrompt, /mention alone does not make the person visible/i);

  const lockedStylePrompt = internals.buildTimelinePrompt(
    batches[0] as TimelineBatch & { index: number },
    batches.length,
    "A complete story.",
    {
      style: "Stickman, flat 2D illustration, white background",
      palette: "black, white, red accents",
      lighting: "",
      continuityNotes: "",
      aspectRatio: "16:9",
    },
  );
  assert.match(lockedStylePrompt, /Non-empty user fields are locked/);
  assert.match(lockedStylePrompt, /generate values for these blank fields: lighting, continuityNotes/);
  assert.match(lockedStylePrompt, /Stickman, flat 2D illustration, white background/);
  assert.match(lockedStylePrompt, /Copy it character-for-character from the user input/);
  assert.match(lockedStylePrompt, /Treat graphic style as external Google Flow configuration, not scene content/);
  assert.match(lockedStylePrompt, /Spend the prompt budget on the other visible parts of the shot/);
  assert.match(lockedStylePrompt, /Do NOT repeat global graphic style, palette, default lighting/);
  assert.match(lockedStylePrompt, /facial expression, head angle, posture, gesture/);
  assert.match(lockedStylePrompt, /No additional foreground or background elements are required/);
  assert.match(lockedStylePrompt, /one continuous, physically possible shot lasting exactly the required boundary duration/);
  assert.match(lockedStylePrompt, /SETTING AND BACKGROUND:/);
  assert.match(lockedStylePrompt, /natural timing: appropriate acceleration and deceleration/);
  assert.match(lockedStylePrompt, /do not force every shot to be slow/);
  assert.match(lockedStylePrompt, /Primary motion must visibly occupy at least 60%/);
  assert.match(lockedStylePrompt, /For 4s: begin the primary motion immediately/);
  assert.match(lockedStylePrompt, /For 8s: anticipation is at most 1.5s/);
  assert.match(lockedStylePrompt, /never slow-motion, floaty, suspended, or dreamlike/);

  const retryPrompt = internals.buildTimelineRetryPrompt(
    batches[0] as TimelineBatch & { index: number },
    batches.length,
    "invalid output",
    1,
  );
  assert.match(retryPrompt, /Primary motion visibly occupies at least 60%/);
  assert.match(retryPrompt, /For 6s, primary motion occupies about 3.5–4.5s/);
  assert.match(retryPrompt, /never stretch a small gesture to fill 8s/);

  const filler = Array.from({ length: 72 }, (_, index) => `visible${index}`).join(" ");
  const detailedImagePrompt = `SUBJECT AND ACTION: a figure opens a door. EMOTION AND BODY LANGUAGE: worried eyes and tense shoulders. SETTING AND BACKGROUND: an old farmhouse at night. DEPTH LAYERS: fence foreground, figure middle-ground, forest background. CAMERA AND COMPOSITION: medium eye-level shot. ${filler}`;
  const detailedVideoPrompt = `STARTING STATE: the figure holds the door. PRIMARY MOTION: one arm slowly pulls it open. REACTION: the face changes from worry to alarm. ENVIRONMENTAL MOTION: a curtain moves gently. CAMERA MOTION: one slow push forward. END FRAME: the figure pauses beside the open doorway. ${filler}`;
  const validationBatch = batches[1] as TimelineBatch & { index: number };
  const validationScenes = validationBatch.boundaries.map((boundary) => ({
    timeStart: String((boundary as unknown as { start?: string }).start || ""),
    timeEnd: String((boundary as unknown as { end?: string }).end || ""),
    imagePrompt: detailedImagePrompt,
    videoPrompt: detailedVideoPrompt,
    usedCharacterTokens: ["@GULLIT", "@NOT_IN_ROSTER"],
  }));
  assert.doesNotThrow(() => internals.validateBatchResult(
    { scenes: validationScenes },
    validationBatch,
    [{ token: "@GULLIT", name: "Gullit" }],
  ));
  assert.deepEqual(Array.from(validationScenes[0].usedCharacterTokens), ["@GULLIT"]);

  const continuationBatch = {
    ...plannedBatches[0],
    index: 1,
  } as TimelineBatch & { index: number };
  const continuationScenes: Array<Record<string, unknown>> = continuationBatch.boundaries.map((boundary) => ({
    timeStart: String(boundary.start || ""),
    timeEnd: String(boundary.end || ""),
    ...(boundary.chainRole === "continue" ? {} : { imagePrompt: detailedImagePrompt }),
    videoPrompt: detailedVideoPrompt,
  }));
  assert.doesNotThrow(() => internals.validateBatchResult(
    { scenes: continuationScenes },
    continuationBatch,
  ));
  assert.equal(continuationScenes[1].imagePrompt, "");

  validationScenes[0].imagePrompt = "too short";
  assert.throws(
    () => internals.validateBatchResult({ scenes: validationScenes }, validationBatch),
    /required 80-150/,
  );
  validationScenes[0].imagePrompt = detailedImagePrompt.replace("SETTING AND BACKGROUND:", "SETTING:");
  validationScenes[0].videoPrompt = detailedVideoPrompt;
  assert.throws(
    () => internals.validateBatchResult({ scenes: validationScenes }, validationBatch),
    /missing required visual sections/,
  );

  const laterPrompt = internals.buildTimelinePrompt(
    batches[1] as TimelineBatch & { index: number },
    batches.length,
    "This must not be repeated in later batches.",
  );
  assert.match(laterPrompt, /Reuse the exact Visual Bible established in batch 1/);
  assert.doesNotMatch(laterPrompt, /"visualBible":/);
});
