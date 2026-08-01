import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePromptFileText,
  detectLocalPromptFilePath,
  importPromptFileText,
  promptFileScenesForMode,
  promptFileWorkflowSourceForMode,
  scenesMatchPromptFileImport,
} from "./prompt-file";

const SAMPLE = [
  "8-second single continuous shot, CLIP 01, photorealistic fantasy ASMR, cinematic 16:9 4K. Begin in a circular hallway with ten closed impossible doors. End centered on the cloud door. Keep the doorway as the clear visual subject. ASMR audio only; no music, narration, dialogue, readable text, logos, subtitles, watermarks, camera shake, or abrupt lighting changes.",
  "8-second single continuous shot, CLIP 02, photorealistic fantasy ASMR, cinematic 16:9 4K. Begin from the exact final frame of Clip 01 in the same circular hallway. Continue the slow forward dolly toward the cloud door. End with the cloud surface filling most of the frame. Keep the doorway as the clear visual subject. ASMR audio only; no music, narration, dialogue, readable text, logos, subtitles, watermarks, camera shake, or abrupt lighting changes.",
  "8-second single continuous shot, CLIP 03, photorealistic fantasy ASMR, cinematic 16:9 4K. Begin as a pale blue line appears at the center of the cloud door. The vapor gently opens into a narrow seam. End with blue sky visible through the opening. Keep the doorway as the clear visual subject. ASMR audio only; no music, narration, dialogue, readable text, logos, subtitles, watermarks, camera shake, or abrupt lighting changes.",
].join("\n");

test("detects absolute local prompt file paths", () => {
  assert.equal(
    detectLocalPromptFilePath("\"C:\\Users\\my pc\\Downloads\\clips.txt\""),
    "C:\\Users\\my pc\\Downloads\\clips.txt",
  );
  assert.equal(detectLocalPromptFilePath("relative\\clips.txt"), null);
  assert.equal(detectLocalPromptFilePath("C:\\Users\\my pc\\Downloads\\clips.png"), null);
  assert.equal(detectLocalPromptFilePath("C:\\one.txt\nC:\\two.txt"), null);
});

test("imports numbered clip prompts as direct-video scenes", () => {
  const result = importPromptFileText(SAMPLE, {
    sourceName: "impossible_doors.txt",
    sourcePath: "C:\\Users\\my pc\\Downloads\\impossible_doors.txt",
  });

  assert.equal(result.summary.clipCount, 3);
  assert.equal(result.summary.totalDurationSeconds, 24);
  assert.equal(result.summary.numberedClipCount, 3);
  assert.equal(result.summary.metadataStrippedCount, 3);
  assert.equal(result.summary.continuationCueCount, 2);
  assert.equal(result.workflowSource.sourceKind, "script");
  assert.equal(result.workflowSource.outputTarget, "video");
  assert.equal(result.workflowSource.videoSourceMode, "direct");
  assert.equal(result.workflowSource.directVideoDelivery, "download");
  assert.equal(result.workflowSource.promptFileVideoMode, "direct-download");
  assert.equal(result.scenes.length, 3);
  assert.equal(result.scenes[0].id, "scene-001");
  assert.equal(result.scenes[0].timeStart, "00:00:00,000");
  assert.equal(result.scenes[2].timeEnd, "00:00:24,000");
  assert.equal(result.scenes[0].chainRole, "start");
  assert.equal(result.scenes[1].chainRole, "continue");
  assert.equal(result.scenes[0].imagePrompt, "");
  assert.doesNotMatch(result.scenes[0].videoPrompt, /\bCLIP\s*01\b/i);
  assert.match(result.scenes[0].videoPrompt, /^8-second single continuous shot, photorealistic/);
  assert.match(result.srtText, /00:00:08,000 --> 00:00:16,000/);
  assert.equal(scenesMatchPromptFileImport(result.scenes, result), true);
});

test("converts prompt files to connected frame chains when requested", () => {
  const result = importPromptFileText(SAMPLE);
  const scenes = promptFileScenesForMode(result, "connected-chain");
  const workflowSource = promptFileWorkflowSourceForMode(result, "connected-chain");

  assert.equal(workflowSource.videoSourceMode, "image-first");
  assert.equal(workflowSource.directVideoDelivery, "download");
  assert.equal(workflowSource.promptFileVideoMode, "connected-chain");
  assert.equal(scenes.length, 3);
  assert.equal(scenes[0].chainRole, "start");
  assert.equal(scenes[1].chainRole, "continue");
  assert.match(scenes[0].imagePrompt, /^Create the opening still frame/);
  assert.equal(scenes[1].imagePrompt, "");
  assert.equal(scenes[1].startingFrameSource, "previous-scene-final-frame");
  assert.equal(scenesMatchPromptFileImport(scenes, result), true);
});

test("reports duplicate or missing clip numbers as blocking issues", () => {
  const duplicate = analyzePromptFileText(SAMPLE.replace("CLIP 03", "CLIP 02"));
  assert.ok(duplicate);
  assert.equal(
    duplicate.issues.some((issue) => issue.severity === "blocking" && issue.code === "duplicate_clip_number"),
    true,
  );
  assert.throws(() => importPromptFileText(SAMPLE.replace("CLIP 03", "CLIP 02")), /appears more than once/);

  const missing = analyzePromptFileText(SAMPLE.replace("CLIP 02", "CLIP 04"));
  assert.ok(missing);
  assert.equal(
    missing.issues.some((issue) => issue.severity === "blocking" && issue.code === "missing_clip_number"),
    true,
  );
});

test("ignores ordinary prose that should still go through timeline generation", () => {
  const result = analyzePromptFileText("A short story about a door.\nIt has a beginning and an end.");
  assert.equal(result, null);
});
