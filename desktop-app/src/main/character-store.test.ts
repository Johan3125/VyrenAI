import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CharacterStore } from "./character-store";

function asArrayBuffer(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const PNG = {
  mimeType: "image/png",
  bytes: asArrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
const JPEG = {
  mimeType: "image/jpeg",
  bytes: asArrayBuffer([0xff, 0xd8, 0xff, 0xd9]),
};

test("persists character CRUD and manages reference images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-characters-"));

  try {
    const store = new CharacterStore(directory);
    await store.initialize();

    const created = await store.create({
      token: "ancestor",
      name: "The Ancestor",
      image: PNG,
    });
    assert.equal(created.token, "@ANCESTOR");
    await access(created.refImagePath);

    const views = await store.listViews();
    assert.equal(views.length, 1);
    assert.match(views[0].refImageDataUrl ?? "", /^data:image\/png;base64,/);

    await assert.rejects(
      store.create({ token: "@ancestor", name: "Duplicate", image: PNG }),
      /đã tồn tại/,
    );

    const updated = await store.update({
      originalToken: "@ancestor",
      token: "@elder",
      name: "The Elder",
      image: JPEG,
    });
    assert.equal(updated.token, "@ELDER");
    assert.equal(updated.name, "The Elder");
    await assert.rejects(access(created.refImagePath));
    await access(updated.refImagePath);

    const reloaded = new CharacterStore(directory);
    await reloaded.initialize();
    assert.deepEqual(await reloaded.list(), [updated]);

    await reloaded.remove("elder");
    assert.deepEqual(await reloaded.list(), []);
    await assert.rejects(access(updated.refImagePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported or spoofed image data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-characters-"));

  try {
    const store = new CharacterStore(directory);
    await assert.rejects(
      store.create({
        token: "hero",
        name: "Hero",
        image: {
          mimeType: "image/png",
          bytes: asArrayBuffer([0x3c, 0x73, 0x76, 0x67, 0x3e]),
        },
      }),
      /PNG, JPEG hoặc WebP/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds prompt tokens to Phase 2 reference images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowx-ref-binding-"));

  try {
    const store = new CharacterStore(directory);
    await store.create({ token: "ancestor", name: "The Ancestor", image: PNG });
    const references = await store.resolvePromptReferences(
      "@ANCESTOR enters the temple while @ANCESTOR looks back.",
    );

    assert.equal(references.length, 1);
    assert.equal(references[0].token, "@ANCESTOR");
    assert.equal(references[0].name, "The Ancestor");
    assert.equal(references[0].mimeType, "image/png");
    assert.match(references[0].localPath, /[.]png$/);
    assert.equal(
      Buffer.from(references[0].imageBase64, "base64").subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );

    await assert.rejects(
      store.resolvePromptReferences("@MISSING walks into frame"),
      /@MISSING/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
