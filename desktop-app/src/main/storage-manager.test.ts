import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectDatabase } from "./project-database";
import { STORAGE_FOLDER_NAME } from "../shared/brand";
import {
  finishStorageMigration,
  prepareStorage,
  readStoragePreference,
  rebaseProjectDatabasePaths,
  resolveStorageLayout,
  writeStoragePreference,
} from "./storage-manager";

test("storage layout prefers drive D and supports isolated test roots", () => {
  const drive = resolveStorageLayout({ documentsRoot: "C:\\Users\\Test\\Documents", platform: "win32", driveDExists: true });
  assert.equal(drive.root, `D:\\${STORAGE_FOLDER_NAME}`);
  assert.equal(drive.outputRoot, `D:\\${STORAGE_FOLDER_NAME}\\Outputs`);
  assert.equal(drive.source, "drive-d");

  const isolated = resolveStorageLayout({
    documentsRoot: "C:\\Users\\Test\\Documents",
    flowxDataRoot: "C:\\Temp\\kc-test",
    platform: "win32",
    driveDExists: true,
  });
  assert.equal(isolated.dataRoot, "C:\\Temp\\kc-test");
  assert.equal(isolated.outputRoot, "C:\\Temp\\kc-test\\outputs");
  assert.equal(isolated.source, "environment");
});

test("persists a selected root and remembers the previous root for restart migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-storage-pref-"));
  const preferencePath = join(root, "storage-location.json");
  await writeStoragePreference(preferencePath, join(root, "new-root"), join(root, "old-root"));
  const preference = await readStoragePreference(preferencePath);
  assert.equal(preference?.rootPath, join(root, "new-root"));
  assert.equal(preference?.previousRootPath, join(root, "old-root"));
  await rm(root, { recursive: true, force: true });
});

test("moves a centralized layout to a newly selected root", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-storage-change-"));
  const previousRoot = join(root, "previous", STORAGE_FOLDER_NAME);
  const nextRoot = join(root, "next", STORAGE_FOLDER_NAME);
  await mkdir(join(previousRoot, "Outputs", "session-one"), { recursive: true });
  await mkdir(join(previousRoot, "Data", "timeline-session"), { recursive: true });
  await writeFile(join(previousRoot, "Outputs", "session-one", "scene-001.mp4"), "clip");
  await writeFile(join(previousRoot, "Data", "timeline-session", "session.json"), JSON.stringify({
    videoResultPath: join(previousRoot, "Outputs", "session-one", "scene-001.mp4"),
  }));
  const layout = resolveStorageLayout({
    documentsRoot: root,
    environmentRoot: nextRoot,
    platform: process.platform,
    driveDExists: false,
  });
  const migration = await prepareStorage(layout, {
    legacyUserDataRoot: join(root, "unused-user-data"),
    legacyOutputRoot: join(root, "unused-downloads"),
    previousStorageRoot: previousRoot,
  });
  const session = JSON.parse(await readFile(join(layout.dataRoot, "timeline-session", "session.json"), "utf8"));
  assert.equal(session.videoResultPath, join(layout.outputRoot, "session-one", "scene-001.mp4"));
  await finishStorageMigration(layout, migration);
  assert.equal(await stat(join(previousRoot, "Outputs")).catch(() => null), null);
  assert.ok(await stat(join(layout.outputRoot, "session-one", "scene-001.mp4")));
  await rm(root, { recursive: true, force: true });
});

test("storage migration copies files, rebases JSON and SQLite, then removes legacy business data", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-storage-"));
  const legacyData = join(root, "legacy-data");
  const legacyOutput = join(root, "legacy-output");
  const targetRoot = join(root, "target");
  const layout = resolveStorageLayout({
    documentsRoot: root,
    environmentRoot: targetRoot,
    platform: process.platform,
    driveDExists: false,
  });
  const sessionDirectory = join(legacyData, "timeline-session");
  const databaseDirectory = join(legacyData, "project-database");
  const oldVideo = join(legacyOutput, "session-test", "scene-001.mp4");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(databaseDirectory, { recursive: true });
  await mkdir(join(legacyOutput, "session-test"), { recursive: true });
  await writeFile(oldVideo, "video");
  await writeFile(join(sessionDirectory, "session.json"), JSON.stringify({
    sessions: [{ workflowSource: { audioPath: join(legacyOutput, "session-test", "audio", "voice.mp3") }, scenes: [{ videoResultPath: oldVideo }] }],
  }));

  const oldDatabase = new ProjectDatabase(join(databaseDirectory, "flowx.sqlite"));
  await oldDatabase.initialize();
  oldDatabase.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
  oldDatabase.db.prepare(`
    INSERT INTO scenes (
      id, project_id, order_index, time_start, time_end, image_prompt, video_prompt,
      chain_role, duration_seconds, status, video_asset_path, updated_at
    ) VALUES ('scene-001', 'project', 1, '00:00:00,000', '00:00:08,000', 'image', 'video', 'single', 8, 'video_done', ?, 'now')
  `).run(oldVideo);
  oldDatabase.close();

  const migration = await prepareStorage(layout, {
    legacyUserDataRoot: legacyData,
    legacyOutputRoot: legacyOutput,
  });
  assert.equal(migration.migrated, true);
  assert.equal((await stat(join(layout.outputRoot, "session-test", "scene-001.mp4"))).size, 5);
  const session = JSON.parse(await readFile(join(layout.dataRoot, "timeline-session", "session.json"), "utf8"));
  assert.equal(session.sessions[0].scenes[0].videoResultPath, join(layout.outputRoot, "session-test", "scene-001.mp4"));

  const database = new ProjectDatabase(join(layout.dataRoot, "project-database", "flowx.sqlite"));
  await database.initialize();
  rebaseProjectDatabasePaths(database, migration.pathMappings);
  const scene = database.db.prepare("SELECT video_asset_path FROM scenes WHERE id = 'scene-001'").get() as { video_asset_path: string };
  assert.equal(scene.video_asset_path, join(layout.outputRoot, "session-test", "scene-001.mp4"));
  database.close();

  await finishStorageMigration(layout, migration);
  assert.equal(await stat(legacyOutput).catch(() => null), null);
  assert.equal(await stat(join(legacyData, "timeline-session")).catch(() => null), null);
  assert.ok(await stat(join(layout.dataRoot, "storage-migration.json")));
  await rm(root, { recursive: true, force: true });
});

test("storage migration never overwrites an existing session with stale legacy data", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-storage-conflict-"));
  const legacyData = join(root, "legacy-data");
  const targetRoot = join(root, "target");
  const targetSession = join(targetRoot, "Data", "timeline-session", "session.json");
  const legacySession = join(legacyData, "timeline-session", "session.json");
  await mkdir(join(targetRoot, "Data", "timeline-session"), { recursive: true });
  await mkdir(join(legacyData, "timeline-session"), { recursive: true });
  await writeFile(targetSession, JSON.stringify({ sessions: [{ id: "current", scenes: [1, 2, 3] }] }));
  await writeFile(legacySession, JSON.stringify({ sessions: [{ id: "stale", scenes: [] }] }));
  const layout = resolveStorageLayout({
    documentsRoot: root,
    environmentRoot: targetRoot,
    platform: process.platform,
    driveDExists: false,
  });
  const migration = await prepareStorage(layout, {
    legacyUserDataRoot: legacyData,
    legacyOutputRoot: join(root, "unused-output"),
  });
  assert.deepEqual(JSON.parse(await readFile(targetSession, "utf8")).sessions[0].id, "current");
  await finishStorageMigration(layout, migration);
  assert.ok(await stat(legacySession));
  await rm(root, { recursive: true, force: true });
});
