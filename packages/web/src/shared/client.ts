/**
 * CouchmodeClient - the WebSocket wrapper shared by /tv and /phone.
 *
 * Handles reconnect with backoff, pairing, liveness, and a typed event emitter.
 * Nothing in here interprets ACP: `acp` messages are handed to listeners
 * untouched.
 *
 * The connection state is deliberately more detailed than "up or down". From a
 * sofa you cannot open devtools, so the UI has to be able to say which of these
 * is true - still connecting for the first time, lost the bridge and retrying
 * in four seconds, or genuinely live - and that distinction has to come from
 * here rather than be guessed at by each client.
 */
import type { ClientMessage, ClientType, ServerMessage } from "./protocol.js";

export type ConnectionState =
  /** Nothing attempted yet: no code entered. */
  | "idle"
  /** Opening the socket for the first time. */
  | "connecting"
  /** Opening the socket again after having been paired. */
  | "reconnecting"
  /** Socket open, `pair` sent, waiting for `hello`. */
  | "pairing"
  /** Live. */
  | "paired"
  /** Socket down, waiting out the backoff before the next attempt. */
  | "offline"
  /** The bridge refused the pair code. Not retried - the code is wrong. */
  | "rejected";

export interface ConnectionStatus {
  state: ConnectionState;
  /** Consecutive failed attempts since the last successful pairing. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt, while `offline`. */
  retryAt: number | null;
  /** True once paired at least once, so `offline` means the link *dropped*. */
  everPaired: boolean;
  /** Epoch ms the current link was established, while `paired`. */
  since: number | null;
}

type EventMap = {
  status: ConnectionStatus;
  message: ServerMessage;
  /** The replay buffer follows: rebuild state rather than appending to it. */
  replayStart: number;
  replayEnd: number;
};

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;

/**
 * Liveness. A TV that sleeps, or an access point that hands the client to
 * another radio, leaves a socket that is open as far as the browser is
 * concerned and silent as far as the bridge is concerned. `close` never fires,
 * so backoff never starts and the screen sits there showing a frozen
 * transcript. An application-level ping is the only way to notice.
 */
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;

export class CouchmodeClient {
  private socket: WebSocket | null = null;
  private listeners: { [K in keyof EventMap]: Set<Listener<K>> } = {
    status: new Set(),
    message: new Set(),
    replayStart: new Set(),
    replayEnd: new Set(),
  };
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private closedByUs = false;
  private code: string | null = null;
  private status: ConnectionStatus = {
    state: "idle",
    attempt: 0,
    retryAt: null,
    everPaired: false,
    since: null,
  };
  /** When the bridge last said anything at all, for the liveness check. */
  private lastHeard = 0;

  constructor(private readonly clientType: ClientType) {}

  get connectionState(): ConnectionState {
    return this.status.state;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** True when the link is live enough for what is on screen to be current. */
  get isLive(): boolean {
    return this.status.state === "paired";
  }

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): void {
    this.listeners[event].add(listener);
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }

  private setState(state: ConnectionState, patch: Partial<ConnectionStatus> = {}): void {
    const next = { ...this.status, ...patch, state };
    const unchanged =
      next.state === this.status.state &&
      next.attempt === this.status.attempt &&
      next.retryAt === this.status.retryAt &&
      next.everPaired === this.status.everPaired &&
      next.since === this.status.since;
    if (unchanged) return;
    this.status = next;
    this.emit("status", next);
  }

  /** Connect and pair with `code`. Safe to call again to re-pair. */
  connect(code: string): void {
    this.code = code;
    this.closedByUs = false;
    this.backoff = RECONNECT_MIN_MS;
    this.openSocket();
  }

  /**
   * Stop waiting out the backoff and try immediately. Wired to the "Try now"
   * control, because the alternative from a sofa is staring at a countdown.
   */
  retryNow(): void {
    if (!this.code || this.status.state === "rejected") return;
    this.backoff = RECONNECT_MIN_MS;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    // Orphan the old socket before closing it. Its handlers compare against
    // `this.socket` and bail when they are no longer the current one, so the
    // close that follows cannot schedule a reconnect on top of this attempt.
    const previous = this.socket;
    this.socket = null;
    previous?.close();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    this.setState(this.status.everPaired ? "reconnecting" : "connecting", { retryAt: null });

    socket.addEventListener("open", () => {
      this.lastHeard = Date.now();
      this.setState("pairing");
      if (this.code) this.send({ type: "pair", code: this.code, clientType: this.clientType });
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      this.lastHeard = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "hello") {
        // A successful pair clears the backoff. Doing it here rather than on
        // `open` means a bridge that accepts the socket and then drops it does
        // not reset the backoff on every attempt.
        this.backoff = RECONNECT_MIN_MS;
        this.setState("paired", {
          attempt: 0,
          retryAt: null,
          everPaired: true,
          since: this.status.state === "paired" ? this.status.since : Date.now(),
        });
      }
      if (message.type === "error" && message.message === "wrong pair code") {
        this.setState("rejected", { retryAt: null });
        this.closedByUs = true;
        this.stopHeartbeat();
        socket.close();
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "replay_start") this.emit("replayStart", message.count);
      if (message.type === "replay_end") this.emit("replayEnd", message.count);

      this.emit("message", message);
    });

    socket.addEventListener("close", () => {
      this.stopHeartbeat();
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeard > HEARTBEAT_MS + HEARTBEAT_TIMEOUT_MS) {
        // Silent for a whole ping cycle plus grace: the socket is open in name
        // only. Drop it so the normal backoff path takes over.
        socket.close();
        return;
      }
      this.send({ type: "ping" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.setState("offline", {
      attempt: this.status.attempt + 1,
      retryAt: Date.now() + delay,
      since: null,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  submitPrompt(text: string): void {
    this.send({ type: "submit_prompt", text });
  }

  decidePermission(requestId: string, optionId: string): void {
    this.send({ type: "permission_decision", requestId, optionId });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  /** Mirror in-progress typing to the other clients. */
  sendDraft(text: string): void {
    this.send({ type: "prompt_draft", text });
  }

  /** Ask the bridge to tear down this agent and start a different one. */
  switchAgent(name: string): void {
    this.send({ type: "switch_agent", name });
  }
}

/** Human wording for a connection status, shared by /tv and /phone. */
export function connectionLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case "idle":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "pairing":
      return "Pairing…";
    case "paired":
      return "Connected";
    case "rejected":
      return "Wrong pair code";
    case "offline": {
      const seconds = Math.max(0, Math.ceil(((status.retryAt ?? 0) - Date.now()) / 1000));
      const when = seconds > 0 ? `retrying in ${seconds}s` : "retrying…";
      return status.everPaired ? `Disconnected · ${when}` : `Can't reach the bridge · ${when}`;
    }
  }
}
