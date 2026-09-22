/**
 * WebSocket hub: pairing, broadcast, and replay for TV and phone clients.
 *
 * A client disconnecting never affects the agent - the bridge holds the ACP
 * session, so the agent keeps working with nobody watching.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { clientMessageSchema } from "./protocol.js";
import type { ClientMessage, ClientType, ConnectedClient, ServerMessage } from "./protocol.js";
import { log, warn } from "./log.js";

/** Messages a reconnecting client is caught up with. */
const REPLAY_LIMIT = 300;

const REPLAYABLE: ReadonlySet<ServerMessage["type"]> = new Set([
  "acp",
  "agent_status",
  "permission_request",
  "permission_resolved",
]);

interface Peer {
  id: string;
  socket: WebSocket;
  clientType: ClientType | null;
  paired: boolean;
  alive: boolean;
}

export interface HubHandlers {
  /** Built fresh per client, so `clients` reflects the current set. */
  buildHello(clients: ConnectedClient[]): ServerMessage;
  onSubmitPrompt(text: string, from: ClientType): void;
  onPermissionDecision(requestId: string, optionId: string, from: ClientType): void;
  onCancel(from: ClientType): void;
  onSwitchAgent(name: string, from: ClientType): void;
}

export class Hub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly peers = new Map<string, Peer>();
  private readonly history: ServerMessage[] = [];
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly pairCode: string,
    private readonly handlers: HubHandlers,
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });

    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (!peer.alive) {
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  private accept(socket: WebSocket): void {
    const peer: Peer = { id: randomUUID(), socket, clientType: null, paired: false, alive: true };
    this.peers.set(peer.id, peer);
    log("ws", "--", `connect ${peer.id.slice(0, 8)}`);

    socket.on("pong", () => {
      peer.alive = true;
    });

    socket.on("message", (raw) => {
      let parsed: ClientMessage;
      try {
        const result = clientMessageSchema.safeParse(JSON.parse(String(raw)));
        if (!result.success) {
          this.sendTo(peer, {
            type: "error",
            message: `invalid message: ${result.error.issues[0]?.message ?? "unknown"}`,
          });
          return;
        }
        parsed = result.data;
      } catch {
        this.sendTo(peer, { type: "error", message: "invalid JSON" });
        return;
      }
      this.handleMessage(peer, parsed);
    });

    socket.on("close", () => {
      this.peers.delete(peer.id);
      log("ws", "--", `close ${peer.id.slice(0, 8)}`);
      if (peer.paired) this.announceClients();
    });

    socket.on("error", (error: Error) => warn(`ws ${peer.id.slice(0, 8)}: ${error.message}`));
  }

  private handleMessage(peer: Peer, message: ClientMessage): void {
    if (message.type === "ping") {
      this.sendTo(peer, { type: "pong" });
      return;
    }

    if (message.type === "pair") {
      if (message.code !== this.pairCode) {
        log("ws", "<-", `pair rejected (${peer.id.slice(0, 8)})`);
        this.sendTo(peer, { type: "error", message: "wrong pair code" });
        return;
      }
      peer.paired = true;
      peer.clientType = message.clientType;
      log("ws", "<-", `pair ok ${message.clientType} (${peer.id.slice(0, 8)})`);
      // One hello to everyone, so the new client is greeted and the existing
      // ones see the updated client list, then catch this client up.
      this.announceClients();
      // Bracket the replay. A client that is re-pairing after a dropped
      // connection already holds a transcript; `replay_start` tells it to drop
      // that and rebuild from what follows, rather than appending a duplicate.
      this.sendTo(peer, { type: "replay_start", count: this.history.length });
      for (const entry of this.history) this.sendTo(peer, entry);
      this.sendTo(peer, { type: "replay_end", count: this.history.length });
      return;
    }

    if (!peer.paired || !peer.clientType) {
      this.sendTo(peer, { type: "error", message: "not paired" });
      return;
    }

    switch (message.type) {
      case "submit_prompt":
        log("ws", "<-", `submit_prompt from ${peer.clientType} (${message.text.length} chars)`);
        this.handlers.onSubmitPrompt(message.text, peer.clientType);
        break;
      case "permission_decision":
        log("ws", "<-", `permission_decision ${message.optionId} from ${peer.clientType}`);
        this.handlers.onPermissionDecision(message.requestId, message.optionId, peer.clientType);
        break;
      case "cancel":
        log("ws", "<-", `cancel from ${peer.clientType}`);
        this.handlers.onCancel(peer.clientType);
        break;
      case "switch_agent":
        log("ws", "<-", `switch_agent ${message.name} from ${peer.clientType}`);
        this.handlers.onSwitchAgent(message.name, peer.clientType);
        break;
      case "prompt_draft":
        // Relayed straight to the other clients; too chatty to log per keystroke.
        this.relay({ type: "prompt_draft", text: message.text, from: peer.clientType }, peer.id);
        break;
    }
  }

  private connectedClients(): ConnectedClient[] {
    return [...this.peers.values()]
      .filter((peer): peer is Peer & { clientType: ClientType } => peer.paired && !!peer.clientType)
      .map((peer) => ({ id: peer.id, clientType: peer.clientType }));
  }

  /**
   * Re-send `hello` to every paired client.
   *
   * Clients can pair before the ACP session exists - the HTTP server binds
   * first - so their initial `hello` carries no agent info or session mode.
   * Re-announcing corrects them instead of leaving stale data on screen.
   */
  announce(): void {
    this.announceClients();
  }

  /** Re-send `hello` so every client's "clients connected" indicator is current. */
  private announceClients(): void {
    const hello = this.handlers.buildHello(this.connectedClients());
    for (const peer of this.peers.values()) {
      if (peer.paired) this.sendTo(peer, hello);
    }
  }

  /** Send to every paired client except one. Not recorded for replay. */
  private relay(message: ServerMessage, exceptPeerId: string): void {
    for (const peer of this.peers.values()) {
      if (peer.paired && peer.id !== exceptPeerId) this.sendTo(peer, message);
    }
  }

  /** Drop the replay buffer: its contents belong to a finished session. */
  clearHistory(): void {
    this.history.length = 0;
  }

  broadcast(message: ServerMessage): void {
    if (REPLAYABLE.has(message.type)) {
      this.history.push(message);
      if (this.history.length > REPLAY_LIMIT) this.history.shift();
    }
    for (const peer of this.peers.values()) {
      if (peer.paired) this.sendTo(peer, message);
    }
  }

  private sendTo(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState !== peer.socket.OPEN) return;
    peer.socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const peer of this.peers.values()) peer.socket.close();
    this.wss.close();
  }
}
