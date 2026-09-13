/**
 * renderAcpUpdate() and the transcript view-model.
 *
 * Turns ACP `session/update` notifications into display items. Every update
 * type we handle - and every one we deliberately ignore - is documented in
 * docs/acp-on-tv.md; the two lists below are the source of truth for that doc.
 */
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallContentDiff,
  ToolCallFields,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "./protocol.js";

/** `sessionUpdate` discriminator values Couchmode renders. */
export const HANDLED_UPDATES = [
  "agent_message_chunk",
  "user_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
] as const;

/**
 * Update types we accept and intentionally do not render yet, with why.
 * Kept explicit so an unrecognised update is a visible gap, not a silent drop.
 */
export const IGNORED_UPDATES: Record<string, string> = {
  current_mode_update: "session modes are not exposed in the TV UI yet (M4)",
  config_option_option: "session config options are desk-UI concerns",
  config_option_update: "session config options are desk-UI concerns",
  session_info_update: "title/metadata changes do not affect the 10-foot layout yet",
  usage_update: "token and cost counters are planned for the TV top bar (M4)",
  compaction_update: "context compaction is invisible to the viewer",
  compaction_summary_chunk: "context compaction is invisible to the viewer",
  plan_update: "incremental plan edits fold into the last full plan (M4)",
  plan_removed: "incremental plan edits fold into the last full plan (M4)",
};

export type TranscriptItem =
  | { kind: "message"; id: string; role: "agent" | "user"; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool_call"; id: string; call: ToolCallView }
  | { kind: "plan"; id: string; entries: PlanEntry[] };

export interface ToolCallView {
  toolCallId: string;
  title: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
}

export function textOf(content: ContentBlock | undefined): string {
  if (!content) return "";
  if (content.type === "text" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return `[${content.type}]`;
}

/** The icon shown for an ACP `ToolKind`. Kinds exist so clients can do exactly this. */
export function toolKindIcon(kind: ToolKind): string {
  switch (kind) {
    case "read":
      return "📖";
    case "edit":
      return "✏️";
    case "delete":
      return "🗑";
    case "move":
      return "📦";
    case "search":
      return "🔍";
    case "execute":
      return "▶";
    case "think":
      return "💭";
    case "fetch":
      return "🌐";
    default:
      return "🔧";
  }
}

export function isDiff(content: ToolCallContent): content is ToolCallContentDiff {
  return content.type === "diff";
}

/** The most recent diff across all tool calls, for the TV's right-hand panel. */
export function latestDiff(items: TranscriptItem[]): ToolCallContentDiff | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind !== "tool_call") continue;
    for (let j = item.call.content.length - 1; j >= 0; j -= 1) {
      const content = item.call.content[j];
      if (content && isDiff(content)) return content;
    }
  }
  return null;
}

export interface TranscriptEvents {
  onAdd(item: TranscriptItem, index: number): void;
  onUpdate(item: TranscriptItem, index: number): void;
  /** An update arrived that we do not render. */
  onIgnored?(sessionUpdate: string, reason: string): void;
}

/**
 * Accumulates `session/update` notifications into an ordered transcript.
 *
 * Message chunks are coalesced: ACP streams text in pieces, and chunks sharing
 * a `messageId` belong to one message. When an agent omits `messageId` we
 * append to the trailing message of the same role instead.
 */
export class TranscriptModel {
  readonly items: TranscriptItem[] = [];
  availableCommands: unknown[] = [];

  private counter = 0;
  private readonly toolIndex = new Map<string, number>();
  private openMessage: {
    id: string;
    role: "agent" | "user" | "thought";
    key: string | null;
  } | null = null;

  constructor(private readonly events: TranscriptEvents) {}

  /**
   * Drop everything. Used when the bridge reports a new ACP session: the items
   * on screen belong to a session that no longer exists.
   */
  clear(): void {
    this.items.length = 0;
    this.toolIndex.clear();
    this.openMessage = null;
    this.availableCommands = [];
    this.counter = 0;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private appendChunk(
    role: "agent" | "user" | "thought",
    content: ContentBlock,
    messageId: string | null | undefined,
  ): void {
    const key = messageId ?? null;
    const text = textOf(content);
    const open = this.openMessage;

    if (open && open.role === role && (key === null || open.key === key)) {
      const index = this.items.findIndex((item) => item.id === open.id);
      const item = this.items[index];
      if (item && (item.kind === "message" || item.kind === "thought")) {
        item.text += text;
        this.events.onUpdate(item, index);
        return;
      }
    }

    const id = this.nextId(role);
    const item: TranscriptItem =
      role === "thought" ? { kind: "thought", id, text } : { kind: "message", id, role, text };
    this.items.push(item);
    this.openMessage = { id, role, key };
    this.events.onAdd(item, this.items.length - 1);
  }

  private upsertToolCall(fields: Partial<ToolCallFields> & { toolCallId: string }): void {
    const existing = this.toolIndex.get(fields.toolCallId);
    if (existing === undefined) {
      const view: ToolCallView = {
        toolCallId: fields.toolCallId,
        title: fields.title ?? fields.toolCallId,
        toolKind: fields.kind ?? "other",
        status: fields.status ?? "pending",
        content: fields.content ?? [],
        locations: fields.locations ?? [],
        ...(fields.rawInput ? { rawInput: fields.rawInput } : {}),
      };
      const item: TranscriptItem = { kind: "tool_call", id: this.nextId("tool"), call: view };
      this.items.push(item);
      this.toolIndex.set(fields.toolCallId, this.items.length - 1);
      this.openMessage = null;
      this.events.onAdd(item, this.items.length - 1);
      return;
    }

    const item = this.items[existing];
    if (!item || item.kind !== "tool_call") return;
    // ACP: "All fields except toolCallId are optional in updates. Only the
    // fields being changed need to be included."
    if (fields.title !== undefined) item.call.title = fields.title;
    if (fields.kind !== undefined) item.call.toolKind = fields.kind;
    if (fields.status !== undefined) item.call.status = fields.status;
    if (fields.content !== undefined) item.call.content = fields.content;
    if (fields.locations !== undefined) item.call.locations = fields.locations;
    if (fields.rawInput !== undefined) item.call.rawInput = fields.rawInput;
    this.events.onUpdate(item, existing);
  }

  /** Feed one ACP `SessionUpdate`. Returns true when it produced UI. */
  apply(update: SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendChunk(
          "agent",
          update.content as ContentBlock,
          update.messageId as string | null,
        );
        return true;
      case "user_message_chunk":
        this.appendChunk("user", update.content as ContentBlock, update.messageId as string | null);
        return true;
      case "agent_thought_chunk":
        this.appendChunk(
          "thought",
          update.content as ContentBlock,
          update.messageId as string | null,
        );
        return true;
      case "tool_call":
        this.upsertToolCall(update as unknown as ToolCallFields);
        return true;
      case "tool_call_update":
        this.upsertToolCall(update as unknown as Partial<ToolCallFields> & { toolCallId: string });
        return true;
      case "plan": {
        const entries = ((update as { entries?: PlanEntry[] }).entries ?? []) as PlanEntry[];
        const index = this.items.findIndex((item) => item.kind === "plan");
        if (index >= 0) {
          const item = this.items[index];
          if (item?.kind === "plan") {
            item.entries = entries;
            this.events.onUpdate(item, index);
            return true;
          }
        }
        const item: TranscriptItem = { kind: "plan", id: this.nextId("plan"), entries };
        this.items.push(item);
        this.events.onAdd(item, this.items.length - 1);
        return true;
      }
      case "available_commands_update":
        this.availableCommands =
          (update as { availableCommands?: unknown[] }).availableCommands ?? [];
        return true;
      default: {
        const reason = IGNORED_UPDATES[update.sessionUpdate] ?? "not recognised by this client";
        this.events.onIgnored?.(update.sessionUpdate, reason);
        return false;
      }
    }
  }
}

/** Escape text for safe insertion as HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Deliberately tiny markdown subset: fenced code, headings, bullets, inline
 * code and bold. Agents emit plain markdown text and a 10-foot UI needs very
 * little of it.
 */
export function renderMarkdown(source: string): string {
  const blocks = source.split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) {
        const [maybeLang, ...rest] = block.split("\n");
        const body = rest.length > 0 ? rest.join("\n") : (maybeLang ?? "");
        return `<pre class="code"><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`;
      }
      return block
        .split("\n")
        .map((line) => {
          const heading = /^(#{1,4})\s+(.*)$/.exec(line);
          if (heading) {
            const level = Math.min(heading[1]!.length + 1, 5);
            return `<h${level}>${inline(heading[2]!)}</h${level}>`;
          }
          const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
          if (bullet) return `<div class="bullet">• ${inline(bullet[1]!)}</div>`;
          const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
          if (numbered) return `<div class="bullet">${numbered[1]}. ${inline(numbered[2]!)}</div>`;
          if (line.trim() === "") return "";
          return `<p>${inline(line)}</p>`;
        })
        .join("");
    })
    .join("");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  text: string;
}

export interface DiffView {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * ACP diffs carry whole-file `oldText` / `newText`, not a unified patch, so the
 * client computes the line diff. A simple LCS is plenty at file sizes an agent
 * edits, and keeps output stable enough to read from the couch.
 */
export function buildDiff(diff: ToolCallContentDiff): DiffView {
  const oldLines = (diff.oldText ?? "").length > 0 ? (diff.oldText ?? "").split("\n") : [];
  const newLines = diff.newText.length > 0 ? diff.newText.split("\n") : [];
  const lines = lcsDiff(oldLines, newLines);
  return {
    path: diff.path,
    lines,
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "remove").length,
  };
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // Guard against pathological inputs; fall back to whole-file replacement.
  if (n * m > 4_000_000) {
    return [
      ...a.map((text): DiffLine => ({ type: "remove", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: "remove", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ type: "remove", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}
