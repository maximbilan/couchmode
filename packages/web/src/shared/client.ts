/**
 * CouchmodeClient - the WebSocket wrapper shared by /tv and /phone.
 *
 * Handles reconnect with backoff, pairing, and a typed event emitter. Nothing
 * in here interprets ACP: `acp` messages are handed to listeners untouched.
 */
import type { ClientMessage, ClientType, ServerMessage } from "./protocol.js";

export type ConnectionState = "connecting" | "pairing" | "paired" | "offline" | "rejected";

type EventMap = {
  state: ConnectionState;
  message: ServerMessage;
  replayEnd: number;
};

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;

export class CouchmodeClient {
  private socket: WebSocket | null = null;
  private listeners: { [K in keyof EventMap]: Set<Listener<K>> } = {
    state: new Set(),
    message: new Set(),
    replayEnd: new Set(),
  };
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private closedByUs = false;
  private code: string | null = null;
  private state: ConnectionState = "offline";

  constructor(private readonly clientType: ClientType) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  get pairCode(): string | null {
    return this.code;
  }

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  /** Connect and pair with `code`. Safe to call again to re-pair. */
  connect(code: string): void {
    this.code = code;
    this.closedByUs = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    this.setState("connecting");

    socket.addEventListener("open", () => {
      this.backoff = RECONNECT_MIN_MS;
      this.setState("pairing");
      if (this.code) this.send({ type: "pair", code: this.code, clientType: this.clientType });
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "hello") this.setState("paired");
      if (message.type === "error" && message.message === "wrong pair code") {
        this.setState("rejected");
        this.closedByUs = true;
        socket.close();
        return;
      }
      if (message.type === "replay_end") this.emit("replayEnd", message.count);

      this.emit("message", message);
    });

    socket.addEventListener("close", () => {
      if (this.closedByUs) return;
      this.setState("offline");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
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

  disconnect(): void {
    this.closedByUs = true;
    this.socket?.close();
    this.setState("offline");
  }
}
