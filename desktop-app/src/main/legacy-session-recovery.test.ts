import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PROJECT_ID } from "../shared/production-queue";
import {
  reconcileTimelineSessionsFromProjects,
  recoverLegacySessionFromProject,
} from "./legacy-session-recovery";
import { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";
import { TimelineSessionStore } from "./timeline-session-store";

test("recovers an empty v3 workspace from the legacy SQLite project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kc-legacy-recovery-"));
  const database = new ProjectDatabase(join(directory, "project.sqlite"));
  try {
    await database.initialize();
    const repositories = new ProjectRepositories(database);
    repositories.projects.create({
      id: DEFAULT_PROJECT_ID,
      name: "Recovered project",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    const bible = repositories.visualBibles.create({
      id: `${DEFAULT_PROJECT_ID}:visual-bible:1`,
      projectId: DEFAULT_PROJECT_ID,
      version: 1,
      stylePresetId: null,
      payloadJson: JSON.stringify({
        style: "hand drawn",
        palette: "black and white",
        lighting: "flat daylight",
        continuityNotes: "stable proportions",
        aspectRatio: "16:9",
      }),
      contentHash: "legacy-hash",
      locked: false,
      anchorImagePaths: [],
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    repositories.scenes.create({
      id: `${DEFAULT_PROJECT_ID}:scene-001`,
      projectId: DEFAULT_PROJECT_ID,
      batchIndex: 0,
      orderIndex: 0,
      timeStart: "00:00:00,000",
      timeEnd: "00:00:08,000",
      imagePrompt: "Recovered image prompt",
      videoPrompt: "Recovered video prompt",
      usedCharacterTokens: [],
      narrationSrtRange: null,
      visualBibleId: bible.id,
      chainId: null,
      chainRole: "single",
      durationSeconds: 8,
      startFrameAssetPath: null,
      status: "video_done",
      imageAssetPath: "C:/Vyren AI/scene-001.png",
      flowImageAssetId: "asset:scene-001",
      videoAssetPath: "C:/Vyren AI/scene-001.mp4",
      approvedImage: true,
      approvedVideo: false,
      lastError: null,
      updatedAt: "2026-07-16T11:00:00.000Z",
    });

    const store = new TimelineSessionStore(join(directory, "timeline"));
    const recovered = await recoverLegacySessionFromProject(database, store);
    assert.equal(recovered?.scenes.length, 1);
    assert.equal((await store.load())?.id, DEFAULT_PROJECT_ID);
    assert.equal((await store.load())?.scenes[0].videoResultPath, "C:/Vyren AI/scene-001.mp4");
    assert.deepEqual((await store.list()).map((session) => session.sceneCount), [1]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairs one empty timeline session from its matching production project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kc-session-reconcile-"));
  const database = new ProjectDatabase(join(directory, "project.sqlite"));
  try {
    await database.initialize();
    const repositories = new ProjectRepositories(database);
    const projectId = "session-production-active";
    repositories.projects.create({
      id: projectId,
      name: "Production session",
      createdAt: "2026-07-20T10:00:00.000Z",
    });
    const bible = repositories.visualBibles.create({
      id: `${projectId}:visual-bible:1`,
      projectId,
      version: 1,
      stylePresetId: null,
      payloadJson: JSON.stringify({
        style: "locked visual style",
        palette: "blue and white",
        lighting: "soft daylight",
        continuityNotes: "preserve character proportions",
        aspectRatio: "16:9",
      }),
      contentHash: "session-reconcile-hash",
      locked: true,
      anchorImagePaths: [],
      createdAt: "2026-07-20T10:00:00.000Z",
    });
    repositories.scenes.create({
      id: `${projectId}:scene-001`,
      projectId,
      batchIndex: 0,
      orderIndex: 0,
      timeStart: "00:00:00,000",
      timeEnd: "00:00:08,000",
      imagePrompt: "Recovered opening frame",
      videoPrompt: "Recovered production motion",
      usedCharacterTokens: ["@HOST"],
      narrationSrtRange: null,
      visualBibleId: bible.id,
      chainId: "chain-001",
      chainRole: "start",
      durationSeconds: 8,
      startFrameAssetPath: "C:/Vyren AI/frame-start.png",
      status: "video_queued",
      imageAssetPath: "C:/Vyren AI/scene-001.png",
      flowImageAssetId: "asset:scene-001",
      videoAssetPath: null,
      approvedImage: true,
      approvedVideo: false,
      lastError: null,
      updatedAt: "2026-07-20T11:00:00.000Z",
    });

    const store = new TimelineSessionStore(join(directory, "timeline"));
    await store.save({
      scenes: [{
        id: "other-scene",
        order: 1,
        timeStart: "00:00:00,000",
        timeEnd: "00:00:04,000",
        imagePrompt: "Other scene",
        imageStatus: "pending",
        imageResultPath: "",
        imageApproved: false,
        videoPrompt: "Other motion",
        videoStatus: "pending",
        videoResultPath: "",
        videoApproved: false,
        usedCharacterTokens: [],
      }],
      visualBible: { style: "other style" },
    }, DEFAULT_PROJECT_ID);
    await store.save({
      scenes: [],
      visualBible: { style: "session style must be preserved" },
      workflowMode: "automatic",
    }, projectId);

    const repaired = await reconcileTimelineSessionsFromProjects(database, store);
    const restored = await store.load(projectId);
    assert.equal(repaired.length, 1);
    assert.equal(restored?.scenes.length, 1);
    // Runtime queue state remains authoritative in SQLite; persisted timeline
    // normalization intentionally resets interrupted UI-only states to pending.
    assert.equal(restored?.scenes[0].videoStatus, "pending");
    assert.equal(restored?.scenes[0].actualContinuityFrame?.path, "C:/Vyren AI/frame-start.png");
    assert.equal(restored?.visualBible.style, "session style must be preserved");
    assert.equal((await store.load(DEFAULT_PROJECT_ID))?.scenes.length, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
