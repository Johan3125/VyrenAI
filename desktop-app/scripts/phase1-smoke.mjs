import WebSocket from "ws";

const ENDPOINT = "ws://127.0.0.1:17890";
const HEARTBEAT_TIMEOUT_MS = 60_000;
const SMOKE_WORKER_VERSION = "9.99.0";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createWorker(role, profileTag) {
  const socket = new WebSocket(ENDPOINT);
  let heartbeatResolve;
  let registeredDone = false;
  let registeredResolve;
  const heartbeat = new Promise((resolve) => {
    heartbeatResolve = resolve;
  });

  const registered = new Promise((resolve, reject) => {
    registeredResolve = resolve;
    const timeout = setTimeout(
      () => reject(new Error(`${role} did not connect`)),
      5_000,
    );

    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "REGISTER",
        role,
        profileTag,
        workerVersion: SMOKE_WORKER_VERSION,
      }));
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => {
      if (registeredDone) return;
      clearTimeout(timeout);
      reject(new Error(`${role} registration was rejected (${code}) ${reason.toString()}`.trim()));
    });
    const finishRegistered = () => {
      if (registeredDone) return;
      registeredDone = true;
      clearTimeout(timeout);
      resolve();
    };
    registeredResolve = finishRegistered;
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "STOP" && !message.jobId) {
      registeredResolve();
      return;
    }
    if (message.type !== "PING") return;

    registeredResolve();
    socket.send(JSON.stringify({ type: "PONG", timestamp: message.timestamp }));
    heartbeatResolve();
  });

  return { role, socket, registered, heartbeat };
}

function waitForHeartbeat(worker) {
  return Promise.race([
    worker.heartbeat,
    delay(HEARTBEAT_TIMEOUT_MS).then(() => {
      throw new Error(`${worker.role} did not receive a heartbeat`);
    }),
  ]);
}

const chat = createWorker("chat-worker", "smoke-chat-profile");
const flow = createWorker("flow-worker", "smoke-flow-profile");

try {
  await Promise.all([chat.registered, flow.registered]);
  console.log("Both worker roles registered");

  await Promise.all([waitForHeartbeat(chat), waitForHeartbeat(flow)]);
  console.log("Both worker roles answered the server heartbeat");

  flow.socket.close(1000, "Smoke test role disconnect");
  await delay(1_000);
  console.log("Flow worker disconnected independently");

  chat.socket.close(1000, "Smoke test complete");
  await delay(250);
  console.log("Phase 1 WebSocket smoke test passed");
} finally {
  chat.socket.terminate();
  flow.socket.terminate();
}
