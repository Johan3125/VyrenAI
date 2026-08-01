export const DESKTOP_WS_URL = "ws://127.0.0.1:17890";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

function sameRegistration(left, right) {
  return (
    left?.role === right?.role &&
    left?.profileTag === right?.profileTag &&
    left?.workerVersion === right?.workerVersion &&
    left?.provider === right?.provider &&
    (left?.capabilities || []).join("|") === (right?.capabilities || []).join("|")
  );
}

export class WorkerConnection {
  constructor({
    url = DESKTOP_WS_URL,
    getRegistration,
    onMessage = () => {},
    onStateChange = () => {},
  }) {
    if (typeof getRegistration !== "function") {
      throw new TypeError("getRegistration is required");
    }

    this.url = url;
    this.getRegistration = getRegistration;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.state = "idle";
    this.registration = null;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = true;
    this.refreshQueue = Promise.resolve();
  }

  start() {
    this.stopped = false;
    return this.refreshRegistration();
  }

  ensureConnected() {
    if (this.stopped) this.stopped = false;
    return this.refreshRegistration();
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  refreshRegistration() {
    this.refreshQueue = this.refreshQueue
      .then(() => this.performRegistrationRefresh())
      .catch((error) => {
        console.warn("[Vyren AI Worker] Role detection failed:", error);
        this.setState("disconnected");
        this.scheduleReconnect();
      });
    return this.refreshQueue;
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.registration = null;

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Worker stopped");
    }
    this.setState("idle");
  }

  async performRegistrationRefresh() {
    const nextRegistration = await this.getRegistration();

    if (!nextRegistration) {
      this.registration = null;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();

      const socket = this.socket;
      this.socket = null;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, "Waiting for a supported tab");
      }
      this.setState("waiting");
      return;
    }

    const changed = !sameRegistration(this.registration, nextRegistration);
    this.registration = nextRegistration;

    if (changed && this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000, "Worker role changed");
      this.reconnectAttempt = 0;
    }

    this.connect();
  }

  connect() {
    if (this.stopped || !this.registration) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.clearReconnectTimer();
    this.setState("connecting");

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      console.warn("[Vyren AI Worker] WebSocket creation failed:", error);
      this.setState("disconnected");
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.registration) return;

      this.reconnectAttempt = 0;
      this.setState("connected");
      socket.send(
        JSON.stringify({
          type: "REGISTER",
          role: this.registration.role,
          profileTag: this.registration.profileTag,
          workerVersion: this.registration.workerVersion,
          provider: this.registration.provider,
          capabilities: this.registration.capabilities,
        }),
      );
      console.info(
        `[Vyren AI Worker] Connected as ${this.registration.role} (${this.registration.profileTag})`,
      );
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;

      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        console.warn("[Vyren AI Worker] Ignored invalid JSON from desktop app");
        return;
      }

      if (message?.type === "PING") {
        socket.send(
          JSON.stringify({ type: "PONG", timestamp: message.timestamp }),
        );
        return;
      }

       this.onMessage(message, this);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;

      this.socket = null;
      if (this.stopped || !this.registration) return;

      console.info(
        `[Vyren AI Worker] Disconnected (${event.code || "no code"}), reconnecting`,
      );
      this.setState("disconnected");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        console.warn("[Vyren AI Worker] Cannot reach the desktop app");
      }
    });
  }

  scheduleReconnect() {
    if (this.stopped || !this.registration || this.reconnectTimer) return;

    const index = Math.min(
      this.reconnectAttempt,
      RECONNECT_DELAYS_MS.length - 1,
    );
    const delay = RECONNECT_DELAYS_MS[index];
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.onStateChange(nextState, this.registration);
  }
}
