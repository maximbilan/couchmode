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

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  pairMessageSchema,
  submitPromptMessageSchema,
  permissionDecisionMessageSchema,
  cancelMessageSchema,
  promptDraftMessageSchema,
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
