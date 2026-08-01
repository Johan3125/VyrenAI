import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relocateSceneJobResult } from "./media-relocation";

test("moves a completed Chrome Vyren AI download into the centralized session output", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-relocate-"));
  const source = join(root, "Downloads", "Vyren AI", "session-old", "scene-001.mp4");
  const output = join(root, "Central", "Vyren AI", "Outputs");
  await mkdir(join(root, "Downloads", "Vyren AI", "session-old"), { recursive: true });
  await writeFile(source, "video-result");
  const result = await relocateSceneJobResult({
    sceneId: "scene-001",
    mediaType: "video",
    resultPath: source,
    flowAssetKey: "",
  }, output, "session-new");
  assert.equal(result.resultPath, join(output, "session-new", "scene-001.mp4"));
  assert.equal(await readFile(result.resultPath, "utf8"), "video-result");
  assert.equal(await stat(source).catch(() => null), null);
  await rm(root, { recursive: true, force: true });
});

test("does not move mock or externally managed job results", async () => {
  const root = await mkdtemp(join(tmpdir(), "kc-relocate-external-"));
  const source = join(root, "fixtures", "scene-001.png");
  await mkdir(join(root, "fixtures"), { recursive: true });
  await writeFile(source, "image-result");
  const result = await relocateSceneJobResult({
    sceneId: "scene-001",
    mediaType: "image",
    resultPath: source,
    flowAssetKey: "asset",
  }, join(root, "Vyren AI", "Outputs"), "session-new");
  assert.equal(result.resultPath, source);
  assert.ok(await stat(source));
  await rm(root, { recursive: true, force: true });
});
