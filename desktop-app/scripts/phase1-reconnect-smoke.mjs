import { WebSocketServer } from "ws";
import { WorkerConnection } from "../../extension-worker/worker-connection.js";

const PORT = 17891;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, message, milliseconds = 8_000) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => clearTimeout(timeout));
}

const states = [];
const connection = new WorkerConnection({
  url: ENDPOINT,
  getRegistration: async () => ({
    role: "chat-worker",
    profileTag: "reconnect-smoke-profile",
  }),
  onStateChange: (state) => states.push(state),
});

await connection.start();
await delay(1_250);

const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

let registrationResolve;
let pongResolve;
const registrationReceived = new Promise((resolve) => {
  registrationResolve = resolve;
});
const pongReceived = new Promise((resolve) => {
  pongResolve = resolve;
});

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());

    if (message.type === "REGISTER") {
      registrationResolve(message);
      socket.send(JSON.stringify({ type: "PING", timestamp: 123456 }));
    }

    if (message.type === "PONG" && message.timestamp === 123456) {
      pongResolve(message);
    }
  });
});

try {
  const registration = await withTimeout(
    registrationReceived,
    "Worker did not reconnect and register",
  );
  await withTimeout(pongReceived, "Worker did not answer heartbeat");

  if (registration.role !== "chat-worker") {
    throw new Error("Worker registered the wrong role");
  }
  if (!states.includes("disconnected") || !states.includes("connected")) {
    throw new Error(`Unexpected connection states: ${states.join(", ")}`);
  }

  console.log("Worker reconnected after the server became available");
  console.log("Worker answered PING with a matching PONG");
  console.log("Phase 1 reconnect smoke test passed");
} finally {
  connection.stop();
  await delay(100);
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
}
