import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TimelineSession } from "../shared/timeline";
import type { GraphicStylePreset } from "../shared/visual-style";
import { LEGACY_PROJECT_ID, migrateLegacyProjectData } from "./legacy-project-migration";
import { ProjectDatabase } from "./project-database";
import { ProjectRepositories } from "./project-repositories";

async function temporaryDatabase(): Promise<{
  directory: string;
  database: ProjectDatabase;
  repositories: ProjectRepositories;
}> {
  const directory = await mkdtemp(join(tmpdir(), "flowx-project-db-"));
  const database = new ProjectDatabase(join(directory, "flowx.sqlite"));
  await database.initialize();
  return { directory, database, repositories: new ProjectRepositories(database) };
}

test("creates the complete project schema and logs scene state transitions", async () => {
  const { directory, database, repositories } = await temporaryDatabase();
  try {
    assert.equal(database.schemaVersion, 4);
    const tables = (database.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of [
      "projects", "visual_bibles", "scenes", "jobs", "style_presets",
      "project_sources", "project_characters",
    ]) {
      assert.ok(tables.includes(table), `${table} table should exist`);
    }

    const project = repositories.projects.create({ id: "project-1", name: "Professional project" });
    repositories.sources.upsert({
      projectId: project.id,
      srtText: "1\n00:00:00,000 --> 00:00:08,000\nOpening",
      scriptText: "A complete supporting script",
      srtFileName: "story.srt",
      scriptFileName: "story.txt",
      srtFilePath: "C:/project/story.srt",
      scriptFilePath: "C:/project/story.txt",
      audioFilePath: "C:/project/voice.wav",
      audioFileName: "voice.wav",
      updatedAt: new Date().toISOString(),
    });
    assert.equal(repositories.sources.get(project.id)?.srtFileName, "story.srt");
    repositories.characters.upsert({
      projectId: project.id,
      token: "@HERO",
      name: "Hero",
      refImagePath: "C:/characters/hero.png",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(repositories.characters.listByProject(project.id).length, 1);
    const bible = repositories.visualBibles.create({
      id: "bible-1",
      projectId: project.id,
      version: 1,
      stylePresetId: null,
      payloadJson: '{"style":"stick figure"}',
      contentHash: "hash-bible-1",
      locked: true,
      anchorImagePaths: ["C:/anchors/one.png"],
    });
    repositories.projects.setActiveVisualBible(project.id, bible.id);
    repositories.scenes.create({
      id: "project-1:scene-001",
      projectId: project.id,
      batchIndex: 0,
      orderIndex: 0,
      timeStart: "00:00:00,000",
      timeEnd: "00:00:08,000",
      imagePrompt: "A complete image prompt",
      videoPrompt: "A safe video prompt",
      usedCharacterTokens: ["@HERO"],
      narrationSrtRange: "srt:1-2",
      visualBibleId: bible.id,
      chainId: null,
      chainRole: "single",
      durationSeconds: 8,
      startFrameAssetPath: null,
      status: "prompt_ready",
      imageAssetPath: null,
      flowImageAssetId: null,
      videoAssetPath: null,
      approvedImage: false,
      approvedVideo: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });

    const transition = repositories.scenes.transition({
      sceneId: "project-1:scene-001",
      to: "image_queued",
      jobType: "image",
      payloadHash: "image-payload-1",
    });
    assert.equal(transition.scene.status, "image_queued");
    assert.equal(transition.job.status, "queued");
    assert.equal(transition.job.projectId, project.id);
    assert.equal(repositories.jobs.listByScene(transition.scene.id).length, 1);

    const beatPlanningJob = repositories.jobs.create({
      id: "beat-planning-1",
      projectId: project.id,
      sceneId: null,
      jobType: "beat_planning",
      status: "queued",
      dependsOn: null,
      attempts: 0,
      maxAttempts: 3,
      lastHeartbeatAt: null,
      lastError: null,
      payloadHash: "beat-payload",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(beatPlanningJob.sceneId, null);
    assert.equal(repositories.jobs.listByProject(project.id).length, 2);
    assert.throws(() => repositories.scenes.transition({
      sceneId: transition.scene.id,
      to: "video_done",
      jobType: "video",
      payloadHash: "invalid",
    }), /Invalid scene transition/);
    assert.equal(repositories.jobs.listByScene(transition.scene.id).length, 1);

    repositories.stylePresets.upsert({
      id: "style-1",
      name: "Stylized 3D",
      category: "stylized_3d",
      paramSchemaJson: "{}",
      templateJson: '{"style":"3D"}',
      anchorImagePaths: [],
    });
    assert.equal(repositories.stylePresets.list().length, 1);

    repositories.projects.remove(project.id);
    assert.equal(repositories.scenes.listByProject(project.id).length, 0);
    assert.equal(repositories.jobs.get(transition.job.id), null);
    assert.equal(repositories.jobs.get(beatPlanningJob.id), null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates the latest LowDB timeline and graphic styles idempotently", async () => {
  const { directory, database, repositories } = await temporaryDatabase();
  const session: TimelineSession = {
    id: "legacy-default-project",
    name: "Legacy session",
    createdAt: "2026-07-15T01:02:03.000Z",
    savedAt: "2026-07-15T01:02:03.000Z",
    styleReference: null,
    workflowMode: "two_step",
    workflowSource: {
      srtText: "",
      scriptText: "",
      srtFileName: "",
      scriptFileName: "",
      srtPath: "",
      scriptPath: "",
      audioPath: "",
      audioFileName: "",
    },
    visualBible: {
      style: "Hand-drawn stick figures",
      palette: "black, white, amber",
      lighting: "soft daylight",
      continuityNotes: "Keep round heads",
      aspectRatio: "16:9",
    },
    scenes: [{
      id: "scene-001",
      order: 1,
      timeStart: "00:00:00,000",
      timeEnd: "00:00:08,000",
      imagePrompt: "Saved complete image prompt",
      imageStatus: "done",
      imageResultPath: "C:/FlowX/scene-001.png",
      imageFlowAssetKey: "path:https://flow.google/scene-001",
      imageApproved: false,
      videoPrompt: "Saved safe video prompt",
      videoStatus: "pending",
      videoResultPath: "",
      videoApproved: false,
      usedCharacterTokens: ["@HERO"],
      characterPolicy: "selected",
      assignedCharacterTokens: ["@HERO"],
      chainId: null,
      chainRole: "single",
      durationSeconds: 8,
    }],
  };
  const presets: GraphicStylePreset[] = [{
    id: "preset-stick",
    name: "Người que chuyên nghiệp",
    style: "Hand-drawn stick figure with complete environments",
    builtIn: false,
    createdAt: session.savedAt,
    updatedAt: session.savedAt,
  }];
  const characters = [{
    token: "@HERO",
    name: "Hero",
    refImagePath: "C:/FlowX/characters/hero.png",
  }];

  try {
    const first = migrateLegacyProjectData(database, session, presets, characters);
    assert.equal(first.migrated, true);
    assert.equal(first.sceneCount, 1);
    assert.equal(first.characterCount, 1);
    const scene = repositories.scenes.listByProject(LEGACY_PROJECT_ID)[0];
    assert.equal(scene.status, "image_done");
    assert.equal(scene.imageAssetPath, "C:/FlowX/scene-001.png");
    assert.equal(scene.flowImageAssetId, "path:https://flow.google/scene-001");
    assert.deepEqual(scene.usedCharacterTokens, ["@HERO"]);
    assert.equal(repositories.visualBibles.listByProject(LEGACY_PROJECT_ID).length, 1);
    assert.equal(repositories.stylePresets.get("preset-stick")?.category, "stick_figure_2d");
    assert.equal(
      repositories.characters.get(LEGACY_PROJECT_ID, "@HERO")?.refImagePath,
      characters[0].refImagePath,
    );

    const second = migrateLegacyProjectData(database, session, presets, characters);
    assert.equal(second.migrated, false);
    assert.equal(repositories.scenes.listByProject(LEGACY_PROJECT_ID).length, 1);

    const changed = structuredClone(session);
    changed.scenes[0].imagePrompt = "Updated prompt from the latest saved LowDB session";
    assert.equal(migrateLegacyProjectData(database, changed, presets, characters).migrated, true);
    assert.equal(
      repositories.scenes.listByProject(LEGACY_PROJECT_ID)[0].imagePrompt,
      changed.scenes[0].imagePrompt,
    );

    database.close();
    const reopened = new ProjectDatabase(join(directory, "flowx.sqlite"));
    await reopened.initialize();
    assert.equal(new ProjectRepositories(reopened).projects.list().length, 1);
    reopened.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
