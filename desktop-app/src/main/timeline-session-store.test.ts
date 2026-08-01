import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TimelineSessionStore } from "./timeline-session-store";

const SCENES = [
  {
    id: "scene-001",
    order: 1,
    timeStart: "00:00:00,000",
    timeEnd: "00:00:08,000",
    imagePrompt: "A saved scene",
    imageStatus: "done" as const,
    imageResultPath: "mock://phase4/image/scene-001/saved",
    imageFlowAssetKey: "path:https://flow.google/assets/scene-001",
    imageApproved: false,
    videoPrompt: "Camera tracks forward",
    videoStatus: "pending" as const,
    videoResultPath: "",
    videoApproved: false,
    usedCharacterTokens: [],
  },
];

test("persists, switches, renames, and deletes multiple timeline sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-timeline-"));
  try {
    const store = new TimelineSessionStore(directory);
    const saved = await store.save({
      scenes: SCENES,
      visualBible: {
        style: "cinematic 3D",
        palette: "teal and gold",
        lighting: "soft sunset",
        continuityNotes: "Keep wardrobe unchanged",
        aspectRatio: "16:9",
      },
      styleReference: {
        name: "sample.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      workflowMode: "automatic",
      workflowSource: {
        srtText: "1\n00:00:00,000 --> 00:00:08,000\nOpening",
        scriptText: "A saved source script",
        srtFileName: "story.srt",
        scriptFileName: "story.txt",
        srtPath: "C:/project/story.srt",
        scriptPath: "C:/project/story.txt",
        audioPath: "C:/project/voice.mp3",
        audioFileName: "voice.mp3",
        audioSource: "imported",
        audioDurationSeconds: 8.2,
        audioSizeBytes: 128_000,
      },
    });
    assert.equal(saved.scenes[0].imagePrompt, "A saved scene");
    assert.equal(saved.visualBible.palette, "teal and gold");

    const reloaded = new TimelineSessionStore(directory);
    const restored = await reloaded.load();
    assert.equal(restored?.scenes.length, 1);
    assert.equal(restored?.scenes[0].imageResultPath, SCENES[0].imageResultPath);
    assert.equal(restored?.scenes[0].imageFlowAssetKey, SCENES[0].imageFlowAssetKey);
    assert.equal(restored?.visualBible.style, "cinematic 3D");
    assert.equal(restored?.styleReference?.name, "sample.png");
    assert.equal(restored?.workflowMode, "automatic");
    assert.equal(restored?.workflowSource.audioFileName, "voice.mp3");
    assert.equal(restored?.workflowSource.audioSource, "imported");
    assert.equal(restored?.workflowSource.audioDurationSeconds, 8.2);
    assert.equal(restored?.workflowSource.audioSizeBytes, 128_000);

    const second = await reloaded.create("Project two");
    assert.equal((await reloaded.list()).length, 2);
    assert.equal((await reloaded.load())?.id, second.id);
    await reloaded.save({
      scenes: [],
      visualBible: {
        style: "flat 2D",
        palette: "black and white",
        lighting: "flat",
        continuityNotes: "stable shapes",
        aspectRatio: "16:9",
      },
    });
    assert.equal((await reloaded.load())?.scenes.length, 0);
    await reloaded.rename(second.id, "Renamed project");
    assert.equal((await reloaded.list()).find((item) => item.id === second.id)?.name, "Renamed project");

    await reloaded.select(saved.id);
    assert.equal((await reloaded.load())?.scenes.length, 1);
    const deleted = await reloaded.delete(saved.id);
    assert.equal(deleted.activeSession?.id, second.id);
    assert.equal(deleted.sessions.length, 1);

    await reloaded.clear();
    assert.equal((await reloaded.load())?.scenes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates the version 2 single session without losing its timeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-timeline-v2-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({
      version: 2,
      session: {
        scenes: SCENES,
        visualBible: {
          style: "legacy hand drawn style",
          palette: "black and white",
          lighting: "flat daylight",
          continuityNotes: "preserve proportions",
          aspectRatio: "16:9",
        },
        savedAt: "2026-07-16T12:00:00.000Z",
      },
    }));
    const store = new TimelineSessionStore(directory);
    const migrated = await store.load();
    assert.equal(migrated?.id, "legacy-default-project");
    assert.equal(migrated?.name, "Phiên làm việc trước đây");
    assert.equal(migrated?.scenes[0].imageResultPath, SCENES[0].imageResultPath);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not let a stale empty save erase an existing Phase 3 timeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-timeline-stale-save-"));
  try {
    const store = new TimelineSessionStore(directory);
    await store.save({
      scenes: SCENES,
      visualBible: { style: "locked production style" },
      workflowMode: "automatic",
    });

    const saved = await store.save({
      scenes: [],
      visualBible: { style: "updated metadata" },
      workflowMode: "automatic",
    });

    assert.equal(saved.scenes.length, 1);
    assert.equal(saved.scenes[0].id, "scene-001");
    assert.equal(saved.visualBible.style, "updated metadata");

    await store.clear();
    assert.equal((await store.load())?.scenes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
