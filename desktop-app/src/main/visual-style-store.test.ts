import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VisualStyleStore } from "./visual-style-store";

test("persists reusable graphic styles separately from timeline sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-styles-"));
  try {
    const store = new VisualStyleStore(directory);
    const initial = await store.list();
    assert.equal(initial.length, 1);
    assert.equal(initial[0].builtIn, true);
    assert.match(initial[0].style, /foreground, middle-ground, and background/i);
    assert.match(initial[0].style, /never tree-like/i);

    const saved = await store.save({
      name: "My case-file stickman",
      style: "Hand-drawn stick figures with red evidence accents and complete environments.",
    });
    const custom = saved.find((preset) => !preset.builtIn);
    assert.equal(custom?.name, "My case-file stickman");

    const overwritten = await store.save({
      name: "my case-file stickman",
      style: "Updated hand-drawn stick figures with readable backgrounds.",
    });
    assert.equal(overwritten.length, 2);
    assert.match(overwritten.find((preset) => !preset.builtIn)?.style || "", /Updated/);

    const reloaded = new VisualStyleStore(directory);
    const restored = await reloaded.list();
    assert.equal(restored.length, 2);
    assert.equal(restored.find((preset) => !preset.builtIn)?.name, "My case-file stickman");

    await assert.rejects(() => reloaded.remove(initial[0].id), /preset mặc định/);
    const afterDelete = await reloaded.remove(custom!.id);
    assert.deepEqual(afterDelete.map((preset) => preset.id), [initial[0].id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

