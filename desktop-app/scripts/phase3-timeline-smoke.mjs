import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const dataDirectory = await mkdtemp(join(tmpdir(), "flowx-phase3-smoke-"));
const electronUserDataDirectory = join(dataDirectory, "electron-user-data");
const srtPath = join(dataDirectory, "sample.srt");
const scriptPath = join(dataDirectory, "script.txt");
const characterLibraryDirectory = join(dataDirectory, "character-library");
const characterImagePath = join(characterLibraryDirectory, "images", "ancestor.png");
const screenshotPath = join(tmpdir(), "flowx-phase5-smoke.png");
const cdpPort = 9228;
const workerPort = 17903;
const srtText = `1
00:00:00,000 --> 00:00:08,000
The ancestor enters the temple.

2
00:00:08,000 --> 00:00:16,000
The doors close behind him.`;
const scriptText = "@ANCESTOR walks into an ancient temple at sunrise.";

await writeFile(srtPath, srtText, "utf8");
await writeFile(scriptPath, scriptText, "utf8");
await mkdir(dirname(characterImagePath), { recursive: true });
await writeFile(
  characterImagePath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
await writeFile(
  join(characterLibraryDirectory, "characters.json"),
  JSON.stringify({
    characters: [{
      token: "@ANCESTOR",
      name: "The Ancestor",
      refImagePath: characterImagePath,
    }],
  }),
  "utf8",
);

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
electron.stdout.on("data", (chunk) => (electronOutput += chunk.toString()));
electron.stderr.on("data", (chunk) => (electronOutput += chunk.toString()));

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  open() {
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

async function waitFor(client, expression, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(`Boolean(${expression})`)) return;
    await delay(50);
  }
  throw new Error(`Renderer condition timed out: ${expression}`);
}

function connectChatWorker() {
  const socket = new WebSocket(`ws://127.0.0.1:${workerPort}`);
  const job = new Promise((resolveJob, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeline job not received")), 8_000);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", timestamp: message.timestamp }));
      }
      if (message.type === "JOB") {
        clearTimeout(timer);
        resolveJob(message);
      }
    });
  });
  const registered = new Promise((resolveRegistered, reject) => {
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "REGISTER",
          role: "chat-worker",
          profileTag: "phase3-smoke-chat",
          workerVersion: "2.44.0",
        }),
      );
      resolveRegistered();
    });
    socket.once("error", reject);
  });
  return { socket, job, registered };
}

function connectFlowWorker() {
  const socket = new WebSocket(`ws://127.0.0.1:${workerPort}`);
  const job = new Promise((resolveJob, reject) => {
    const timer = setTimeout(() => reject(new Error("Scene job not received")), 30_000);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", timestamp: message.timestamp }));
      }
      if (message.type === "JOB" && message.action === "GENERATE_IMAGE") {
        clearTimeout(timer);
        resolveJob(message);
      }
    });
  });
  const registered = new Promise((resolveRegistered, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "REGISTER",
        role: "flow-worker",
        profileTag: "phase4-smoke-flow",
        workerVersion: "2.47.0",
      }));
      resolveRegistered();
    });
    socket.once("error", reject);
  });
  return { socket, job, registered };
}

let client;
let worker;
let flowWorker;

try {
  const target = await waitForTarget();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await client.evaluate("document.querySelector('.kc-launch-splash button')?.click()");
  await waitFor(client, "document.querySelector('.kc-nav button:nth-child(6)')");
  await client.evaluate("document.querySelector('.kc-nav button:nth-child(6)').click()");
  await waitFor(client, "document.querySelector('.timeline-import')");
  await waitFor(client, "document.querySelector('#timeline-srt-file')");

  worker = connectChatWorker();
  await worker.registered;
  flowWorker = connectFlowWorker();
  await flowWorker.registered;
  await waitFor(
    client,
    "document.querySelectorAll('.chat-readiness').length >= 2 && Array.from(document.querySelectorAll('.chat-readiness')).every((item) => item.classList.contains('is-ready'))",
  );

  const document = await client.send("DOM.getDocument", { depth: 2 });
  for (const [selector, path] of [
    ["#timeline-srt-file", srtPath],
    ["#timeline-script-file", scriptPath],
  ]) {
    const input = await client.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    assert.notEqual(input.nodeId, 0, `${selector} was not rendered`);
    await client.send("DOM.setFileInputFiles", {
      nodeId: input.nodeId,
      files: [path],
    });
  }

  await waitFor(client, "document.querySelector('#kc-vb-style')");
  const overrideGraphicStyle = "Stickman, flat 2D illustration, white background, bold black outlines";
  const overridePalette = "locked black, white, and amber accents";
  const overrideContinuity = "locked round heads, single-line limbs, unchanged scale";
  await client.evaluate(`(() => {
    const input = document.querySelector('#kc-vb-style');
    const styleSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    styleSetter.call(input, ${JSON.stringify(overrideGraphicStyle)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const bibleTextareas = document.querySelectorAll('.kc-vb-dual-fields textarea');
    textareaSetter.call(bibleTextareas[0], ${JSON.stringify(overridePalette)});
    bibleTextareas[0].dispatchEvent(new Event('input', { bubbles: true }));
    const continuity = document.querySelector('.kc-vb-continuity-card textarea');
    textareaSetter.call(continuity, ${JSON.stringify(overrideContinuity)});
    continuity.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    client,
    "!document.querySelector('.timeline-actions .primary').disabled",
  );
  await client.evaluate("document.querySelector('.timeline-actions .primary').click()");

  const job = await worker.job;
  assert.equal(job.action, "GENERATE_TIMELINE");
  assert.equal(job.payload.srtText, srtText);
  assert.equal(job.payload.scriptText, scriptText);
  assert.deepEqual(job.payload.visualBible, {
    style: overrideGraphicStyle,
    palette: overridePalette,
    lighting: "",
    continuityNotes: overrideContinuity,
    aspectRatio: "16:9",
  });

  worker.socket.send(
    JSON.stringify({
      type: "JOB_PROGRESS",
      jobId: job.jobId,
      status: "generating",
      message: "Smoke worker is generating scenes",
    }),
  );
  worker.socket.send(
    JSON.stringify({
      type: "JOB_DONE",
      jobId: job.jobId,
      result: {
        visualBible: {
          style: "cinematic 3D animation, clean stylized forms",
          palette: "warm sandstone, teal shadows, restrained gold accents",
          lighting: "soft sunrise with long directional shadows",
          continuityNotes: "Keep @ANCESTOR's proportions and robe unchanged; preserve the temple layout.",
          aspectRatio: "16:9",
        },
        scenes: [
          {
            timeStart: "00:00:00,000",
            timeEnd: "00:00:08,000",
            durationSeconds: 8,
            chainId: "temple-entry",
            chainRole: "start",
            imagePrompt: "@ancestor entering an ancient temple at sunrise",
            videoPrompt: "Slow tracking shot toward the temple doors",
            usedCharacterTokens: ["ancestor"],
          },
          {
            timeStart: "00:00:08,000",
            timeEnd: "00:00:16,000",
            durationSeconds: 8,
            chainId: "temple-entry",
            chainRole: "continue",
            imagePrompt: "Temple doors closing behind @ANCESTOR",
            videoPrompt: "Doors close as the camera holds steady",
            usedCharacterTokens: ["@ANCESTOR"],
          },
        ],
      },
    }),
  );

  await waitFor(client, "document.querySelectorAll('.timeline-table tbody tr').length === 2");
  const bodyText = await client.evaluate("document.body.innerText");
  assert.match(bodyText, /2 scene/);
  assert.match(bodyText, /@ANCESTOR/);
  const planningUi = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.timeline-table tbody > tr:not(.scene-alternative-row)')];
    return rows.map((row) => ({
      role: row.querySelector('.scene-chain-cell select').value,
      chainId: row.querySelector('.scene-chain-cell input').value,
      duration: row.querySelector('.scene-duration-cell select').value,
    }));
  })()`);
  assert.deepEqual(planningUi, [
    { role: "start", chainId: "temple-entry", duration: "8" },
    { role: "continue", chainId: "temple-entry", duration: "8" },
  ]);
  const graphicStyle = await client.evaluate("document.querySelector('#kc-vb-style').value");
  assert.equal(graphicStyle, overrideGraphicStyle);
  await waitFor(client, "document.querySelector('.kc-vb-dual-fields')");
  const bibleValues = await client.evaluate(`Array.from(document.querySelectorAll('.kc-vb-dual-fields textarea')).map((input) => input.value)`);
  assert.ok(bibleValues.includes(overridePalette));
  assert.ok(bibleValues.includes("soft sunrise with long directional shadows"));
  const continuityValue = await client.evaluate("document.querySelector('.kc-vb-continuity-card textarea').value");
  assert.equal(continuityValue, overrideContinuity);
  const initialVideoPrompt = await client.evaluate("document.querySelectorAll('.scene-prompt')[1].value");
  assert.match(initialVideoPrompt, /Slow tracking shot/);

  const revisedPrompt = "@ANCESTOR revised prompt for scene one only";
  await client.evaluate(`(() => {
    const input = document.querySelector('.timeline-table tbody tr .scene-prompt');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(revisedPrompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.timeline-table tbody tr .scene-job-actions button').click();
  })()`);
  await waitFor(client, "document.querySelector('.generation-modal')");
  const modalText = await client.evaluate("document.querySelector('.generation-modal').innerText");
  assert.match(modalText, /Nano Banana Pro/);
  assert.match(modalText, /0 tín dụng/);
  assert.match(modalText, /@ANCESTOR/);
  assert.match(modalText, /Stickman, flat 2D illustration/);
  await client.evaluate("document.querySelector('.generation-modal-footer .primary').click()");
  const sceneJob = await flowWorker.job;
  assert.equal(sceneJob.action, "GENERATE_IMAGE");
  assert.equal(sceneJob.payload.sceneId, "scene-001");
  assert.equal(sceneJob.payload.prompt, revisedPrompt);
  assert.deepEqual(sceneJob.payload.characterTokens, ["@ANCESTOR"]);
  assert.equal(sceneJob.payload.imageSettings.model, "nano-banana-pro");
  assert.equal(sceneJob.payload.imageSettings.expectedCredits, 0);
  assert.equal(sceneJob.payload.visualBible.style, overrideGraphicStyle);
  assert.equal(sceneJob.payload.refImages.length, 1);
  assert.equal(sceneJob.payload.refImages[0].token, "@ANCESTOR");
  assert.equal(sceneJob.payload.refImages[0].name, "The Ancestor");
  assert.equal(sceneJob.payload.refImages[0].mimeType, "image/png");
  assert.equal(sceneJob.payload.refImages[0].localPath, characterImagePath);
  assert.ok(sceneJob.payload.refImages[0].imageBase64.length > 20);
  flowWorker.socket.send(JSON.stringify({
    type: "JOB_PROGRESS",
    jobId: sceneJob.jobId,
    status: "generating",
    message: "Generating scene one",
  }));
  flowWorker.socket.send(JSON.stringify({
    type: "JOB_DONE",
    jobId: sceneJob.jobId,
    result: {
      sceneId: "scene-001",
      mediaType: "image",
      resultPath: "mock://phase4/image/scene-001/smoke",
      flowAssetKey: "path:https://flow.google/assets/scene-001-smoke",
    },
  }));
  await waitFor(client, "document.querySelector('.timeline-table tbody tr .scene-status').classList.contains('is-done')");
  const statuses = await client.evaluate("[...document.querySelectorAll('.timeline-table tbody > tr:not(.scene-alternative-row)')].map(row => row.querySelector('.scene-status').textContent.trim())");
  assert.match(statuses[0], /Hoàn tất/);
  assert.match(statuses[1], /Chờ/);
  const queueUi = await client.evaluate(`(() => {
    const row = document.querySelector('.timeline-table tbody > tr:not(.scene-alternative-row)');
    const cell = row.querySelector('.scene-job-cell');
    const cellBounds = cell.closest('td').getBoundingClientRect();
    const buttonsFit = [...cell.querySelectorAll('button')].every((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.left >= cellBounds.left && bounds.right <= cellBounds.right + 1;
    });
    return {
      buttonsFit,
      hasAutomaticPipeline: Boolean(document.querySelector('.production-queue-actions .button.primary')),
    };
  })()`);
  assert.equal(queueUi.buttonsFit, true);
  assert.equal(queueUi.hasAutomaticPipeline, true);
  await client.evaluate("document.querySelectorAll('.timeline-table tbody > tr:not(.scene-alternative-row)')[0].querySelectorAll('.scene-job-cell')[1].querySelector('button').click()");
  await waitFor(client, "document.querySelector('.generation-modal')");
  const videoModalText = await client.evaluate("document.querySelector('.generation-modal').innerText");
  assert.match(videoModalText, /Veo 3.1 Lite/);
  assert.match(videoModalText, /Khung hình bắt đầu của video/);
  assert.match(videoModalText, /Khung hình đầu/);
  await client.evaluate("document.querySelector('.generation-modal-header .icon-button').click()");
  await client.evaluate("document.querySelectorAll('.timeline-actions .button.secondary')[1].click()");
  await delay(50);
  await waitFor(client, "!document.querySelectorAll('.timeline-actions .button.secondary')[1].disabled");
  await waitFor(client, "document.querySelector('.timeline-progress')?.innerText.includes('2 scene')");

  await client.send("Page.reload", { ignoreCache: true });
  await delay(500);
  await waitFor(client, "document.querySelectorAll('.timeline-table tbody > tr:not(.scene-alternative-row)').length === 2");
  const restoredPrompt = await client.evaluate("document.querySelector('.timeline-table tbody tr .scene-prompt').value");
  const restoredStatus = await client.evaluate("document.querySelector('.timeline-table tbody tr .scene-status').textContent.trim()");
  assert.equal(restoredPrompt, revisedPrompt);
  assert.match(restoredStatus, /Hoàn tất/);

  await client.evaluate("document.querySelector('.workspace-session-actions .icon-button').click()");
  await waitFor(client, "document.querySelector('.session-reset-modal')");
  const resetModalText = await client.evaluate("document.querySelector('.session-reset-modal').innerText");
  assert.match(resetModalText, /Xóa phiên|XÃ³a phiÃªn/);
  await client.evaluate("document.querySelector('.session-reset-modal .secondary').click()");
  await waitFor(client, "!document.querySelector('.session-reset-modal')");
  assert.equal(await client.evaluate("document.querySelectorAll('.timeline-table tbody > tr:not(.scene-alternative-row)').length"), 2);

  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  console.log("Timeline files submitted through the rendered Electron UI");
  console.log("GENERATE_TIMELINE payload received by the chat worker");
  console.log("Scene result normalized and rendered as a two-row table");
  console.log("Phase 4 prompt edit and image rerun updated only scene one");
  console.log("Queue action buttons stay inside their cells and the automatic Image-to-Video pipeline is visible");
  console.log("Phase 5 Ref Binding attached @ANCESTOR image bytes to the Flow job");
  console.log("Phase 6 modal bound the completed scene image as the only video Start frame");
  console.log("Session deletion requires a second explicit confirmation");
  console.log("Timeline session restored after a renderer reload");
  console.log(`Phase 5 UI screenshot: ${screenshotPath}`);
  console.log("Phase 5 desktop-to-worker Ref Binding smoke test passed");
} finally {
  client?.close();
  worker?.socket.terminate();
  flowWorker?.socket.terminate();
  electron.kill();
  await delay(300);
  await rm(dataDirectory, { recursive: true, force: true });
}
