import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPackage = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
const appTitle = appPackage.productName || appPackage.build?.productName || "Vyren AI";
const electronPath = join(
  appDirectory,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const dataDirectory = await mkdtemp(join(tmpdir(), "flowx-phase2-smoke-"));
const electronUserDataDirectory = join(dataDirectory, "electron-user-data");
const imagePath = join(dataDirectory, "reference.png");
const screenshotPath = join(tmpdir(), "flowx-phase2-smoke.png");
const cdpPort = 9226;
const workerPort = 17902;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

await writeFile(imagePath, tinyPng);

const electron = spawn(electronPath, [
  ".",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${electronUserDataDirectory}`,
], {
  cwd: appDirectory,
  env: {
    ...process.env,
    FLOWX_DATA_DIR: dataDirectory,
    FLOWX_WORKER_PORT: String(workerPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let electronOutput = "";
electron.stdout.on("data", (chunk) => {
  electronOutput += chunk.toString();
});
electron.stderr.on("data", (chunk) => {
  electronOutput += chunk.toString();
});

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForTarget() {
  const deadline = Date.now() + 30_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      const targets = await response.json();
      lastTargets = targets.map((entry) => ({
        type: entry.type,
        title: entry.title,
        url: entry.url,
        hasWebSocket: Boolean(entry.webSocketDebuggerUrl),
      }));
      const target =
        targets.find((entry) => entry.type === "page" && entry.title === appTitle) ||
        targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error(
    `Electron CDP target did not start (looked for ${appTitle}).\nTargets: ${JSON.stringify(lastTargets)}\n${electronOutput}`,
  );
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();

    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  open() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, reject) => {
      this.socket.once("open", resolveOpen);
      this.socket.once("error", reject);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForSelector(clientInstance, selector) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await clientInstance.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      )
    ) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Renderer did not show ${selector}`);
}

let client;

try {
  const target = await waitForTarget();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await waitForSelector(client, ".kc-nav button:nth-child(4)");
  await client.evaluate(
    "document.querySelector('.kc-nav button:nth-child(4)').click()",
  );
  await waitForSelector(client, ".kc-character-studio");
  await waitForSelector(client, ".kc-character-add-button");

  await client.evaluate(
    "document.querySelector('.kc-character-add-button').click()",
  );
  await delay(100);

  const document = await client.send("DOM.getDocument", { depth: 2 });
  const fileInput = await client.send("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: ".kc-character-upload-zone input[type=file]",
  });
  assert.notEqual(fileInput.nodeId, 0, "Character file input was not rendered");
  await client.send("DOM.setFileInputFiles", {
    nodeId: fileInput.nodeId,
    files: [imagePath],
  });

  const createdText = await client.evaluate(`
    (async () => {
      const inputs = document.querySelectorAll('.kc-character-editor-grid input');
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(inputs[0], 'ancestor');
      setValue(inputs[1], 'The Ancestor');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      document.querySelector('.kc-character-editor-card').requestSubmit();
      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      return document.body.innerText;
    })()
  `);
  assert.match(createdText, /@ANCESTOR/);
  assert.match(createdText, /The Ancestor/);

  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const editedText = await client.evaluate(`
    (async () => {
      document.querySelector('.kc-character-card-actions button').click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const inputs = document.querySelectorAll('.kc-character-editor-grid input');
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(inputs[0], 'elder');
      setValue(inputs[1], 'The Elder');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      document.querySelector('.kc-character-editor-card').requestSubmit();
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      return document.body.innerText;
    })()
  `);
  assert.match(editedText, /@ELDER/);
  assert.match(editedText, /The Elder/);
  assert.doesNotMatch(editedText, /@ANCESTOR/);

  const deletedText = await client.evaluate(`
    (async () => {
      window.confirm = () => true;
      document.querySelector('.kc-character-card-actions button.is-danger').click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      return document.body.innerText;
    })()
  `);
  assert.match(deletedText, /Chưa có nhân vật/);

  const database = JSON.parse(
    await readFile(join(dataDirectory, "character-library", "characters.json"), "utf8"),
  );
  const imageFiles = await readdir(join(dataDirectory, "character-library", "images"));
  assert.deepEqual(database.characters, []);
  assert.deepEqual(imageFiles, []);

  console.log("Character created through the rendered form");
  console.log("Character token and name edited through the rendered form");
  console.log("Character and managed reference image deleted");
  console.log(`Phase 2 UI screenshot: ${screenshotPath}`);
  console.log("Phase 2 character CRUD smoke test passed");
} finally {
  client?.close();
  electron.kill();
  await delay(300);
  await rm(dataDirectory, { recursive: true, force: true });
}
