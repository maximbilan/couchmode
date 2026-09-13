/**
 * The Couchmode ACP client.
 *
 * As far as the agent is concerned, the bridge IS the client: it answers the
 * agent's client-side requests and owns one ACP session for the run. The TV and
 * phone are downstream viewers that never speak to the agent directly.
 *
 * Methods we CALL on the agent (ACP agent-side methods):
 *   initialize, session/new, session/set_mode, session/prompt,
 *   session/cancel (notification)
 *
 * Methods we ANSWER for the agent (ACP client-side methods):
 *   session/update (notification), session/request_permission,
 *   fs/read_text_file, fs/write_text_file
 */
import {
  client as acpClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  InitializeResponse,
  SessionModeState,
  SessionNotification,
  Stream,
  StopReason,
} from "@agentclientprotocol/sdk";
import { ScopedFs } from "./fs.js";
import { PermissionRegistry } from "../permissions.js";
import type { ResolvedBy } from "../permissions.js";
import type { AgentStatus } from "../protocol.js";
import { log, warn } from "../log.js";

/** Client info we send in `initialize`. Carries no user or credential data. */
const CLIENT_NAME = "couchmode";
const CLIENT_TITLE = "Couchmode";

/** At most one prompt in flight; up to this many more may wait behind it. */
export const PROMPT_QUEUE_LIMIT = 3;

/**
 * How long to wait for an agent to answer `initialize`.
 *
 * An agent that cannot start is not always an agent that says so. `gemini --acp`
 * writes nothing at all to stdout or stderr when its account onboarding fails -
 * it simply never replies - and without this the bridge would wait forever and
 * the TV would sit on "Starting" with nothing to show.
 */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface AcpClientEvents {
  onSessionUpdate(notification: SessionNotification): void;
  onStatus(status: AgentStatus, detail?: string): void;
  onPermissionRequest(requestId: string, request: unknown): void;
  onPermissionResolved(requestId: string, optionId: string | null, by: ResolvedBy): void;
}

export interface AgentLike {
  stream: Stream;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export class CouchmodeAcpClient {
  private connection: ClientConnection | null = null;
  private sessionId: string | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private modeState: SessionModeState | null = null;
  private status: AgentStatus = "starting";

  private readonly fs: ScopedFs;
  readonly permissions: PermissionRegistry;

  /** Prompts waiting for the in-flight turn to finish. */
  private readonly queue: string[] = [];
  private busy = false;

  constructor(
    private readonly agent: AgentLike,
    private readonly cwd: string,
    private readonly events: AcpClientEvents,
    private readonly version: string,
    /** Session mode ids to try, most preferred first. */
    private readonly preferredModes: string[] = [],
  ) {
    this.fs = new ScopedFs(cwd);
    this.permissions = new PermissionRegistry((requestId, optionId, by) => {
      this.events.onPermissionResolved(requestId, optionId, by);
      if (this.permissions.size === 0 && this.busy) this.setStatus("prompting");
    });
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  get agentInfo(): InitializeResponse["agentInfo"] | null {
    return this.initializeResponse?.agentInfo ?? null;
  }

  get modes(): SessionModeState | null {
    return this.modeState;
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.events.onStatus(status, detail);
  }

  /** Connect, negotiate, and create the session for `cwd`. */
  async start(): Promise<void> {
    const app = acpClient({ name: CLIENT_NAME })
      // Agent -> client notification carrying all streamed output. Forwarded
      // to TV and phone unchanged.
      .onNotification(methods.client.session.update, (ctx) => {
        const update = ctx.params.update as { sessionUpdate?: string };
        log("acp", "<-", `session/update ${update.sessionUpdate ?? "?"}`);
        this.events.onSessionUpdate(ctx.params);
      })
      // Agent -> client request. Blocks the agent until a human answers.
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const { requestId, response } = this.permissions.open(ctx.params, ctx.params.options);
        log(
          "acp",
          "<-",
          `session/request_permission ${ctx.params.toolCall?.title ?? ctx.params.toolCall?.toolCallId ?? ""}`,
        );
        this.setStatus("waiting_permission");
        this.events.onPermissionRequest(requestId, ctx.params);
        return response;
      })
      .onRequest(methods.client.fs.readTextFile, async (ctx) => {
        log("acp", "<-", `fs/read_text_file ${ctx.params.path}`);
        return this.fs.readTextFile(ctx.params);
      })
      .onRequest(methods.client.fs.writeTextFile, async (ctx) => {
        log("acp", "<-", `fs/write_text_file ${ctx.params.path}`);
        await this.fs.writeTextFile(ctx.params);
        // ACP: the client responds with an empty result on success.
      });

    this.connection = app.connect(this.agent.stream);

    void this.agent.exited.then(({ code, signal }) => {
      const detail = this.agent.stderr().trim();
      this.setStatus(
        "exited",
        detail || `agent exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
      );
    });

    const init = await this.withHandshakeTimeout(
      "initialize",
      this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // We implement both file-system methods, scoped to the session cwd.
          fs: { readTextFile: true, writeTextFile: true },
          // No `terminal`: we do not implement terminal/* yet, and ACP requires
          // clients to treat omitted capabilities as UNSUPPORTED.
        },
        clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: this.version },
      }),
    );
    this.initializeResponse = init;
    log("acp", "->", `initialize -> protocol v${init.protocolVersion}`);

    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `agent speaks ACP v${init.protocolVersion}, Couchmode speaks v${PROTOCOL_VERSION}`,
      );
    }

    const session = await this.withHandshakeTimeout(
      "session/new",
      this.connection.agent.request(methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: [],
      }),
    );
    this.sessionId = session.sessionId;
    this.modeState = session.modes ?? null;
    log("acp", "->", `session/new -> ${session.sessionId}`);

    await this.applyPreferredMode();
    this.setStatus("ready");
  }

  /**
   * Ask the agent for a mode that requests permission before acting.
   *
   * ACP session modes "often affect ... whether they request permission before
   * running". Several agents - the Claude adapter among them - start in a mode
   * where the agent decides permissions itself, which would leave a Couchmode
   * user with nothing to approve. We switch to the first preferred mode the
   * agent actually offers, and otherwise leave the session as we found it.
   */
  private async applyPreferredMode(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    const available = this.modeState?.availableModes ?? [];
    if (available.length === 0 || this.preferredModes.length === 0) return;

    const target = this.preferredModes.find((id) => available.some((mode) => mode.id === id));
    if (!target) {
      warn(
        `none of the preferred modes [${this.preferredModes.join(", ")}] are offered by this agent; ` +
          `staying in "${this.modeState?.currentModeId ?? "unknown"}"`,
      );
      return;
    }
    if (target === this.modeState?.currentModeId) return;

    try {
      await this.connection.agent.request(methods.agent.session.setMode, {
        sessionId: this.sessionId,
        modeId: target,
      });
      if (this.modeState) this.modeState = { ...this.modeState, currentModeId: target };
      log("acp", "->", `session/set_mode ${target}`);
    } catch (error) {
      warn(`session/set_mode ${target} failed: ${errorText(error)}`);
    }
  }

  /**
   * Fail a handshake step rather than waiting on a silent agent forever.
   * The agent process is killed so a hung child does not outlive the attempt.
   */
  private async withHandshakeTimeout<T>(step: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.agent.kill();
        reject(
          new Error(
            `agent did not respond to ${step} within ${HANDSHAKE_TIMEOUT_MS / 1000}s. ` +
              `It may be waiting on a login or an onboarding step that cannot be completed here - ` +
              `try running the agent's own CLI in a terminal to see what it wants.`,
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Auth methods the agent advertised, used only to print a terminal hint. */
  get authMethods(): InitializeResponse["authMethods"] {
    return this.initializeResponse?.authMethods ?? [];
  }

  /**
   * Queue a prompt. One `session/prompt` is in flight at a time; the agent owns
   * turn boundaries, so we do not start the next until the current one stops.
   */
  submitPrompt(text: string): { accepted: boolean; reason?: string } {
    if (!this.sessionId) return { accepted: false, reason: "session is not ready yet" };
    if (this.busy) {
      if (this.queue.length >= PROMPT_QUEUE_LIMIT) {
        return { accepted: false, reason: `prompt queue is full (${PROMPT_QUEUE_LIMIT})` };
      }
      this.queue.push(text);
      return { accepted: true };
    }
    void this.runPrompt(text);
    return { accepted: true };
  }

  private async runPrompt(text: string): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    this.busy = true;
    this.setStatus("prompting");
    log("acp", "->", `session/prompt (${text.length} chars)`);

    let stopReason: StopReason | "error" = "error";
    try {
      const result = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        // Text is the one content type every ACP agent MUST support.
        prompt: [{ type: "text", text }],
      });
      stopReason = result.stopReason;
      log("acp", "<-", `session/prompt done: ${result.stopReason}`);
    } catch (error) {
      const message = errorText(error);
      warn(`session/prompt failed: ${message}`);
      this.setStatus("error", message);
    } finally {
      this.busy = false;
      const next = this.queue.shift();
      if (next !== undefined) {
        void this.runPrompt(next);
      } else if (stopReason !== "error") {
        this.setStatus("ready");
      }
    }
  }

  /**
   * `session/cancel` is a notification, so there is no response to await. Per
   * the spec we also answer every pending permission request with `cancelled`.
   */
  cancel(): void {
    if (!this.connection || !this.sessionId) return;
    this.permissions.cancelAll();
    this.queue.length = 0;
    log("acp", "->", "session/cancel");
    void this.connection.agent
      .notify(methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch((error: unknown) => warn(`session/cancel failed: ${errorText(error)}`));
  }

  decidePermission(requestId: string, optionId: string, by: "tv" | "phone"): boolean {
    return this.permissions.decide(requestId, optionId, by);
  }

  async stop(): Promise<void> {
    this.permissions.cancelAll();
    this.connection?.close();
    this.agent.kill();
  }
}

export function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const data = typeof error.data === "string" ? ` (${error.data})` : "";
    return `${error.message}${data}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
