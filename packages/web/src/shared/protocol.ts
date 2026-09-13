/**
 * Mirror of the bridge's message types (packages/bridge/src/protocol.ts).
 *
 * The web client deliberately has no dependency on the bridge package: the TV
 * shell loads these files over HTTP from a bridge that may be a different
 * version, so the contract is duplicated and kept deliberately small.
 */

export type ClientType = "tv" | "phone";

export type AgentStatus =
  "starting" | "ready" | "prompting" | "waiting_permission" | "error" | "exited";

export interface ConnectedClient {
  id: string;
  clientType: ClientType;
}

export interface HelloMessage {
  type: "hello";
  bridgeVersion: string;
  agentName: string;
  agentTitle: string;
  agentInfo: { name?: string; title?: string | null; version?: string | null } | null;
  cwd: string;
  projectName: string;
  gitBranch: string | null;
  clients: ConnectedClient[];
  status: AgentStatus;
  mode: { currentModeId: string; availableModes: SessionModeSummary[] } | null;
  fake: boolean;
}

export interface SessionModeSummary {
  id: string;
  name: string;
  description?: string | null;
}

export interface AgentStatusMessage {
  type: "agent_status";
  status: AgentStatus;
  detail?: string;
}

export interface AcpMessage {
  type: "acp";
  /** Full ACP `SessionNotification`: `{ sessionId, update }`. */
  payload: SessionNotification;
}

export interface PermissionRequestMessage {
  type: "permission_request";
  requestId: string;
  /** Full ACP `RequestPermissionRequest`. */
  request: RequestPermissionRequest;
}

export interface PermissionResolvedMessage {
  type: "permission_resolved";
  requestId: string;
  optionId: string | null;
  by: ClientType | "timeout" | "cancelled";
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

export type ServerMessage =
  | HelloMessage
  | AgentStatusMessage
  | AcpMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | ReplayEndMessage
  | PongMessage
  | ErrorMessage;

// --- The subset of ACP types the UI reads -----------------------------------
// Names and casing come from the ACP v1 schema. We keep them structural so an
// agent sending extra fields never breaks rendering.

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolKind =
  "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

export interface ContentBlockText {
  type: "text";
  text: string;
}

export type ContentBlock = ContentBlockText | { type: string; [key: string]: unknown };

export interface ToolCallContentDiff {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

export interface ToolCallContentContent {
  type: "content";
  content: ContentBlock;
}

export type ToolCallContent =
  ToolCallContentDiff | ToolCallContentContent | { type: string; [key: string]: unknown };

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: ToolKind;
    status?: ToolCallStatus;
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
    rawInput?: Record<string, unknown>;
    [key: string]: unknown;
  };
  options: PermissionOption[];
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & Partial<ToolCallFields> & { toolCallId: string })
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: string; [key: string]: unknown };

export interface ToolCallFields {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

export type ClientMessage =
  | { type: "pair"; code: string; clientType: ClientType }
  | { type: "submit_prompt"; text: string }
  | { type: "permission_decision"; requestId: string; optionId: string }
  | { type: "cancel" }
  | { type: "ping" };
