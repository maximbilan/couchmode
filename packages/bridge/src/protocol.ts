/**
 * Couchmode bridge protocol.
 *
 * This is the ONLY non-ACP message surface in the system. Everything the agent
 * says is forwarded to clients verbatim inside the `acp` envelope below - we do
 * not invent a protocol, we implement ACP and wrap it for transport over the LAN.
 */
import { z } from "zod";

/** Which surface a connected client is. */
export const clientTypeSchema = z.enum(["tv", "phone"]);
export type ClientType = z.infer<typeof clientTypeSchema>;

/**
 * Lifecycle of the spawned ACP agent process, as surfaced to the UI.
 *
 * `waiting_permission` corresponds to at least one in-flight
 * `session/request_permission` call from the agent (ACP client-side method).
 */
export const agentStatusSchema = z.enum([
  "starting",
  "ready",
  "prompting",
  "waiting_permission",
  "error",
  "exited",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export const pairMessageSchema = z.object({
  type: z.literal("pair"),
  code: z.string().min(1).max(32),
  clientType: clientTypeSchema,
});

export const submitPromptMessageSchema = z.object({
  type: z.literal("submit_prompt"),
  /** Becomes a single ACP `ContentBlock` of `{ type: "text", text }`. */
  text: z.string().min(1).max(32_000),
});

export const permissionDecisionMessageSchema = z.object({
  type: z.literal("permission_decision"),
  /** Bridge-minted id, not an ACP field. Correlates with `permission_request`. */
  requestId: z.string().min(1),
  /** MUST be one of the `optionId`s the agent offered in its ACP request. */
  optionId: z.string().min(1),
});

export const cancelMessageSchema = z.object({
  type: z.literal("cancel"),
});

/**
 * Live draft text, so the TV can mirror what is being typed on the phone
 * before it is sent. Ephemeral: never stored in the replay history.
 */
export const promptDraftMessageSchema = z.object({
  type: z.literal("prompt_draft"),
  text: z.string().max(32_000),
});

/**
 * Ask the bridge to tear down the current agent and start a different one from
 * `agents.json`. The ACP session does not survive: a session belongs to the
 * agent that created it.
 */
export const switchAgentMessageSchema = z.object({
  type: z.literal("switch_agent"),
  name: z.string().min(1).max(64),
});

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  pairMessageSchema,
  submitPromptMessageSchema,
  permissionDecisionMessageSchema,
  cancelMessageSchema,
  promptDraftMessageSchema,
  switchAgentMessageSchema,
  pingMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// server -> client
//
// These are described as types rather than parsed with zod: the bridge is the
// only producer, and `acp` payloads are ACP-shaped values we deliberately pass
// through untouched.
// ---------------------------------------------------------------------------

export type ServerMessage =
  | HelloMessage
  | AgentStatusMessage
  | AcpMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | PromptDraftMessage
  | SessionResetMessage
  | ReplayStartMessage
  | ReplayEndMessage
  | PongMessage
  | ErrorMessage;

export interface HelloMessage {
  type: "hello";
  bridgeVersion: string;
  agentName: string;
  agentTitle: string;
  /** Populated from the ACP `initialize` response `agentInfo`, when the agent sends one. */
  agentInfo: { name?: string; title?: string | null; version?: string | null } | null;
  cwd: string;
  projectName: string;
  gitBranch: string | null;
  clients: ConnectedClient[];
  /** Every agent in agents.json, for the agent picker. */
  agents: AgentSummary[];
  status: AgentStatus;
  /** ACP `SessionModeState` from `session/new`, after Couchmode applied its preference. */
  mode: { currentModeId: string; availableModes: SessionModeSummary[] } | null;
  /** True when the bridge is replaying a recorded session instead of spawning an agent. */
  fake: boolean;
}

export interface SessionModeSummary {
  id: string;
  name: string;
  description?: string | null;
}

export interface AgentSummary {
  name: string;
  title: string;
  /** The launch command, shown under the title so a picker says what it runs. */
  command: string;
  /** The agent currently running. */
  active: boolean;
}

export interface ConnectedClient {
  id: string;
  clientType: ClientType;
}

export interface AgentStatusMessage {
  type: "agent_status";
  status: AgentStatus;
  /** Agent-supplied error text, surfaced verbatim. Never contains credentials. */
  detail?: string;
}

/**
 * A `session/update` notification from the agent, forwarded unchanged.
 * `payload` is the full ACP `SessionNotification` (`{ sessionId, update }`).
 */
export interface AcpMessage {
  type: "acp";
  payload: unknown;
}

/**
 * An in-flight ACP `session/request_permission` request.
 * `request` is the ACP `RequestPermissionRequest` exactly as the agent sent it,
 * including its `options[]` with their `optionId`, `name` and `kind`.
 */
export interface PermissionRequestMessage {
  type: "permission_request";
  requestId: string;
  request: unknown;
}

export interface PermissionResolvedMessage {
  type: "permission_resolved";
  requestId: string;
  /** null when the turn was cancelled - ACP outcome `cancelled` carries no option. */
  optionId: string | null;
  by: ClientType | "timeout" | "cancelled";
}

/** Draft text relayed from one client to the others. */
export interface PromptDraftMessage {
  type: "prompt_draft";
  text: string;
  from: ClientType;
}

/**
 * A new ACP session has begun, so anything clients are showing belongs to a
 * session that no longer exists. Sent when the agent is switched or restarted.
 */
export interface SessionResetMessage {
  type: "session_reset";
  reason: "agent_switched" | "agent_restarted";
  /** The agent the new session belongs to, so clients can label it at once. */
  agentName: string;
  agentTitle: string;
  /** The agent being left behind, when this is a switch rather than a restart. */
  previousTitle: string | null;
}

/**
 * The replay buffer follows.
 *
 * Everything between this and `replay_end` describes the session as it already
 * is, not as it just changed - so a client that is re-pairing after a dropped
 * connection rebuilds its transcript from scratch instead of appending a second
 * copy of every message it already had.
 */
export interface ReplayStartMessage {
  type: "replay_start";
  count: number;
}

export interface ReplayEndMessage {
  type: "replay_end";
  count: number;
}

export interface PongMessage {
  type: "pong";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}
