/**
 * /tv - the 10-foot UI.
 *
 * Everything here is reachable with four arrows, Enter and Back. There is no
 * pointer and no tab order: focus moves by geometry via the shared
 * FocusManager, and a permission request pushes a focus layer so the feed
 * underneath cannot be reached by accident.
 */
import { CouchmodeClient } from "../shared/client.js";
import type { ConnectionState } from "../shared/client.js";
import type {
  AgentStatus,
  AgentSummary,
  HelloMessage,
  PermissionOption,
  RequestPermissionRequest,
  ServerMessage,
  ToolKind,
} from "../shared/protocol.js";
import {
  buildDiff,
  escapeHtml,
  latestDiff,
  renderMarkdown,
  toolKindIcon,
  TranscriptModel,
} from "../shared/render.js";
import type { TranscriptItem } from "../shared/render.js";
import { FocusManager, scrollerKeyHandler, toNavKey } from "../shared/focus.js";

const STORAGE_KEY = "couchmode.tv.code";
const CODE_LENGTH = 6;
/** A whole-file diff can be thousands of lines; nobody reads that from a sofa. */
const DIFF_LINE_LIMIT = 400;

const app = document.querySelector<HTMLDivElement>("#app")!;
const client = new CouchmodeClient("tv");
const focus = new FocusManager();

let hello: HelloMessage | null = null;
let status: AgentStatus = "starting";
let statusDetail = "";
let screen: "pairing" | "main" = "pairing";

/** Pending permission requests, oldest first. Only the first is shown. */
const permissionQueue: Array<{ requestId: string; request: RequestPermissionRequest }> = [];
let modalRequestId: string | null = null;

// ---------------------------------------------------------------- status

const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: "Starting",
  ready: "Ready",
  prompting: "Thinking",
  waiting_permission: "Needs approval",
  error: "Error",
  exited: "Agent exited",
};

/**
 * "Running tool" is not an ACP or bridge status - it is derived, because from
 * across a room "Thinking" and "running your test suite" should not look alike.
 */
function statusLabel(): string {
  if (status === "prompting" && transcript.items.some(isRunningTool)) return "Running tool";
  return STATUS_LABEL[status];
}

function isRunningTool(item: TranscriptItem): boolean {
  return item.kind === "tool_call" && item.call.status === "in_progress";
}

// --------------------------------------------------------------- pairing

function renderPairing(message = ""): void {
  screen = "pairing";
  const fromUrl = new URL(location.href).searchParams.get("code");
  const saved = fromUrl ?? localStorage.getItem(STORAGE_KEY) ?? "";
  const digits = Array.from({ length: CODE_LENGTH }, (_, i) => Number(saved[i] ?? 0) || 0);

  app.innerHTML = `
    <section class="pairing">
      <h1>Couchmode</h1>
      <p class="tagline">Your coding agent, in couch mode.</p>
      <div class="code-boxes" id="boxes"></div>
      <p class="hint">Enter the code from your terminal · <kbd>▲▼</kbd> change · <kbd>◀▶</kbd> move · <kbd>OK</kbd> pair</p>
      <div class="error" id="pair-error">${escapeHtml(message)}</div>
    </section>
  `;

  const boxes = app.querySelector<HTMLElement>("#boxes")!;
  const submit = () => {
    const code = digits.join("");
    localStorage.setItem(STORAGE_KEY, code);
    client.connect(code);
  };

  digits.forEach((_, index) => {
    const box = document.createElement("div");
    box.className = "digit";
    box.innerHTML = `<span class="value">${digits[index]}</span><span class="arrows">▲▼</span>`;
    boxes.append(box);

    focus.register(box, {
      priority: index,
      onEnter: submit,
      // Up/down cycle the digit; left/right fall through to spatial movement.
      onKey: (key) => {
        if (key !== "up" && key !== "down") return false;
        digits[index] = (digits[index]! + (key === "up" ? 1 : 9)) % 10;
        box.querySelector(".value")!.textContent = String(digits[index]);
        return true;
      },
    });
  });

  focus.focusFirstInLayer();
  if (fromUrl) submit();
}

// ------------------------------------------------------------------ feed

let feedEl: HTMLElement | null = null;
let diffBodyEl: HTMLElement | null = null;
let diffHeadEl: HTMLElement | null = null;
let autoScroll = true;

const transcript = new TranscriptModel({
  onAdd: (item, index) => {
    if (!feedEl) return;
    feedEl.querySelector(".empty")?.remove();
    const node = document.createElement("div");
    node.dataset.index = String(index);
    feedEl.append(node);
    paintItem(node, item);
    afterFeedChange();
  },
  onUpdate: (item, index) => {
    const node = feedEl?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!node) return;
    paintItem(node, item);
    afterFeedChange();
  },
  onIgnored: (type, reason) => console.debug(`[couchmode] ignoring ${type}: ${reason}`),
});

function paintItem(node: HTMLElement, item: TranscriptItem): void {
  switch (item.kind) {
    case "message":
      node.className = `msg ${item.role}`;
      node.innerHTML = renderMarkdown(item.text);
      break;
    case "thought":
      node.className = "thought";
      node.innerHTML = `<div class="body">💭 ${escapeHtml(item.text)}</div>`;
      break;
    case "tool_call":
      node.className = "tool";
      node.dataset.status = item.call.status;
      node.innerHTML = `
        <span class="icon">${toolKindIcon(item.call.toolKind)}</span>
        <span class="title">${escapeHtml(oneLine(item.call.title))}</span>
        <span class="status">${escapeHtml(item.call.status.replace("_", " "))}</span>
      `;
      break;
    case "plan":
      node.className = "plan";
      node.innerHTML =
        "<h3>Plan</h3>" +
        item.entries
          .map((entry) => {
            const state = entry.status ?? "pending";
            const mark = state === "completed" ? "✓" : state === "in_progress" ? "▸" : "○";
            return `<div class="entry" data-status="${escapeHtml(state)}"><span class="mark">${mark}</span><span>${escapeHtml(entry.content)}</span></div>`;
          })
          .join("");
      break;
  }
}

/** Tool titles can be whole heredocs; the feed row shows one line. */
function oneLine(value: string): string {
  const firstLine = value.split("\n")[0] ?? "";
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

function afterFeedChange(): void {
  if (autoScroll && feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  paintDiff();
  paintTopbar();
}

// ------------------------------------------------------------------ diff

function paintDiff(): void {
  if (!diffBodyEl || !diffHeadEl) return;
  const diff = latestDiff(transcript.items);
  if (!diff) {
    diffHeadEl.innerHTML = `<span>Changes</span>`;
    diffBodyEl.innerHTML = `<div class="empty">No file changes yet.</div>`;
    return;
  }

  const view = buildDiff(diff);
  diffHeadEl.innerHTML = `
    <span class="path" title="${escapeHtml(view.path)}">${escapeHtml(shortenPath(view.path))}</span>
    <span class="counts"><span class="plus">+${view.added}</span><span class="minus">−${view.removed}</span></span>
  `;

  const shown = view.lines.slice(0, DIFF_LINE_LIMIT);
  const rows = shown
    .map((line) => {
      const sign = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
      return `<div class="line ${line.type}"><span class="sign">${sign}</span><span>${escapeHtml(line.text)}</span></div>`;
    })
    .join("");
  const more =
    view.lines.length > shown.length
      ? `<div class="truncated">… ${view.lines.length - shown.length} more lines</div>`
      : "";
  diffBodyEl.innerHTML = `<div class="diff">${rows}${more}</div>`;
}

/** Keep the tail of a path: the filename matters more than the repo root. */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

// --------------------------------------------------------------- top bar

function paintTopbar(): void {
  const project = app.querySelector<HTMLElement>("#project");
  const branch = app.querySelector<HTMLElement>("#branch");
  const agent = app.querySelector<HTMLElement>("#agent");
  const pill = app.querySelector<HTMLElement>("#status");
  const clients = app.querySelector<HTMLElement>("#clients");
  const banner = app.querySelector<HTMLElement>("#banner");

  if (hello) {
    if (project) project.textContent = hello.projectName;
    if (branch) {
      branch.textContent = hello.gitBranch ?? "no branch";
      branch.hidden = false;
    }
    if (agent) {
      const title = hello.agentInfo?.title ?? hello.agentTitle;
      agent.textContent = hello.fake ? `${title} · replay` : title;
    }
    if (clients) {
      const tv = hello.clients.filter((c) => c.clientType === "tv").length;
      const phone = hello.clients.filter((c) => c.clientType === "phone").length;
      clients.textContent = `📺 ${tv}  📱 ${phone}`;
    }
  }

  if (pill) {
    pill.textContent = statusLabel();
    pill.dataset.status = status;
  }

  if (banner) {
    const offline = client.connectionState !== "paired";
    const text = offline ? "Reconnecting to the bridge…" : statusDetail;
    banner.hidden = text.length === 0;
    banner.textContent = text;
    banner.classList.toggle("offline", offline);
  }
}

// ------------------------------------------------------------ main screen

function renderMain(): void {
  screen = "main";
  app.innerHTML = `
    <div class="topbar">
      <span class="project" id="project">…</span>
      <span class="branch" id="branch" hidden></span>
      <span class="spacer"></span>
      <button class="agent" id="agent"></button>
      <span class="status-pill" id="status" data-status="starting">Starting</span>
      <span class="clients" id="clients"></span>
    </div>
    <div class="banner" id="banner" hidden></div>
    <div class="stage">
      <section class="panel">
        <div class="panel-head"><span>Activity</span></div>
        <div class="scroller feed" id="feed"><div class="empty">Ask the agent something to get started.</div></div>
      </section>
      <section class="panel">
        <div class="panel-head" id="diff-head"><span>Changes</span></div>
        <div class="scroller" id="diff"><div class="empty">No file changes yet.</div></div>
      </section>
    </div>
    <div class="promptbar">
      <div class="prompt-field" id="prompt">
        <span id="prompt-content">Ask the agent… (or type on your phone)</span>
      </div>
      <button class="cancel-button send-button" id="prompt-send" hidden>Send</button>
      <button class="cancel-button" id="cancel">Stop</button>
    </div>
    <div class="hintbar">
      <span><kbd>OK</kbd> on the bar to type</span>
      <span><kbd>OK</kbd> on Activity toggles thinking</span>
      <span><kbd>Back</kbd> closes</span>
    </div>
  `;

  feedEl = app.querySelector<HTMLElement>("#feed");
  diffBodyEl = app.querySelector<HTMLElement>("#diff");
  diffHeadEl = app.querySelector<HTMLElement>("#diff-head");

  // Auto-scroll, unless the viewer has deliberately scrolled up to read.
  feedEl?.addEventListener("scroll", () => {
    if (!feedEl) return;
    autoScroll = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  });

  if (feedEl) {
    focus.register(feedEl, {
      priority: 0,
      onKey: scrollerKeyHandler(feedEl),
      onEnter: () => feedEl?.classList.toggle("thoughts-open"),
    });
  }
  if (diffBodyEl) {
    focus.register(diffBodyEl, { priority: 1, onKey: scrollerKeyHandler(diffBodyEl) });
  }

  const promptField = app.querySelector<HTMLElement>("#prompt")!;
  focus.register(promptField, { priority: 2, onEnter: openComposer });

  const cancel = app.querySelector<HTMLElement>("#cancel")!;
  focus.register(cancel, { priority: 4, onEnter: () => client.cancel() });

  const agentButton = app.querySelector<HTMLElement>("#agent")!;
  focus.register(agentButton, { priority: 5, onEnter: openAgentPicker });

  // Short-press MENU is the shortcut; the Fire TV shell keeps long-press for
  // its own settings form.
  focus.setMenuHandler(openAgentPicker);

  focus.focusFirstInLayer();

  // Repaint anything that arrived before this screen existed.
  for (const [index, item] of transcript.items.entries()) {
    feedEl?.querySelector(".empty")?.remove();
    const node = document.createElement("div");
    node.dataset.index = String(index);
    feedEl?.append(node);
    paintItem(node, item);
  }
  paintTopbar();
  paintDiff();
  if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  showNextPermission();
}

// -------------------------------------------------------------- composer

let composerOpen = false;

/**
 * Enter on the prompt bar swaps in a real <input>. On Fire OS that is what
 * raises the on-screen keyboard; on a desktop browser you simply type.
 */
function openComposer(): void {
  if (composerOpen) return;
  const content = app.querySelector<HTMLElement>("#prompt-content");
  if (!content) return;
  composerOpen = true;

  // The input lives in a form on purpose.
  //
  // On Fire TV every key pressed inside a focused field is routed through the
  // input method and reaches the page as `keyCode 229 / "Unidentified"` - the
  // remote's OK button and Enter are indistinguishable from any other key. A
  // `keydown`-based submit therefore never fires on a TV. Form submission does,
  // because the WebView raises it from the IME's action button.
  content.innerHTML = `<form id="prompt-form" autocomplete="off">
    <input id="prompt-input" type="text" autocomplete="off" enterkeyhint="send"
      placeholder="Ask the agent… (or type on your phone)" />
  </form>`;
  const form = content.querySelector<HTMLFormElement>("#prompt-form")!;
  const input = content.querySelector<HTMLInputElement>("#prompt-input")!;
  input.focus();

  const submit = () => {
    const text = input.value.trim();
    if (text.length > 0) client.submitPrompt(text);
    closeComposer();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  // An explicit Send button.
  //
  // While Fire TV's on-screen keyboard is attached, OK inside the field is
  // swallowed by the IME and arrives as `keyCode 229` / `insertText`, so there
  // is no key that means "submit" while typing. Dismissing the keyboard
  // commits the text as Enter and submits; Send covers every other route -
  // a desk browser, a paired USB keyboard, or a field left focused with the
  // keyboard already gone.
  const send = app.querySelector<HTMLButtonElement>("#prompt-send");
  if (send) {
    send.hidden = false;
    focus.register(send, { priority: 3, onEnter: submit });
  }

  input.addEventListener("keydown", (event) => {
    const key = toNavKey(event);
    if (event.key === "Enter") {
      // Desktop and the acceptance test; a TV never reaches this branch.
      event.preventDefault();
      submit();
      return;
    }
    if (key === "back" && (event.key !== "Backspace" || input.value.length === 0)) {
      event.preventDefault();
      handleBack();
      return;
    }
    if (key === "down" || key === "right") {
      // Let the D-pad leave the field. A single-line input has nothing to do
      // with down, and right at the end of the text is equally spare.
      const atEnd = input.selectionStart === input.value.length;
      if (key === "down" || atEnd) {
        event.preventDefault();
        const target = app.querySelector<HTMLElement>("#prompt-send");
        if (target && !target.hidden) {
          focus.focus(target);
          return;
        }
      }
    }
    // Everything else is typing: keep it away from the focus manager.
    event.stopPropagation();
  });

  input.addEventListener("input", () => client.sendDraft(input.value));
}

function closeComposer(): void {
  composerOpen = false;
  client.sendDraft("");
  const send = app.querySelector<HTMLButtonElement>("#prompt-send");
  if (send) {
    focus.unregister(send);
    send.hidden = true;
  }
  paintPromptField("");
  const field = app.querySelector<HTMLElement>("#prompt");
  if (field) focus.focus(field);
}

/** Draft text from another client, mirrored live. */
function paintPromptField(text: string, from?: string): void {
  if (composerOpen) return;
  const content = app.querySelector<HTMLElement>("#prompt-content");
  if (!content) return;
  content.innerHTML =
    text.length === 0
      ? "Ask the agent… (or type on your phone)"
      : `<span class="value">${escapeHtml(text)}</span>${from ? `<span class="from">${escapeHtml(from)}</span>` : ""}`;
}

// ------------------------------------------------------ permission modal

const READ_ONLY_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "fetch", "think"]);
const DESTRUCTIVE_KINDS: ReadonlySet<ToolKind> = new Set(["execute", "delete"]);
/** Titles that look like a shell command, for agents that leave `kind` unset. */
const SHELLISH = /(^|\s)(rm|sudo|curl|wget|chmod|git|npm|pnpm|yarn|node|python|sh|bash)\s|[|&;>]/;

export type RiskClass = "read_only" | "destructive" | "modifying";

/**
 * Classify a permission request by what it would do, using the ACP `ToolKind`
 * and falling back to the title when an agent leaves `kind` unset.
 *
 * Three classes, not two: an edit is neither a read nor a shell command, and
 * collapsing it into either gets the default button wrong.
 */
export function classifyRequest(request: RequestPermissionRequest): RiskClass {
  const kind = request.toolCall?.kind;
  if (kind && READ_ONLY_KINDS.has(kind)) return "read_only";
  if (kind && DESTRUCTIVE_KINDS.has(kind)) return "destructive";
  if (SHELLISH.test(request.toolCall?.title ?? "")) return "destructive";
  // `edit`, `move`, `other`, and anything unrecognised.
  return "modifying";
}

/**
 * Which button the remote starts on.
 *
 * Reads and edits start on an allow option: the viewer is watching, and for an
 * edit the diff is already on screen beside the modal. Anything that runs a
 * command or deletes starts on the deny option, so a reflexive OK press can
 * never execute something. Back is always the deny option regardless, so the
 * cautious answer is never more than one press away.
 */
export function defaultOption(request: RequestPermissionRequest): PermissionOption | undefined {
  const options = request.options ?? [];
  const allow =
    options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
  const deny = denyOption(request);
  return classifyRequest(request) === "destructive" ? (deny ?? allow) : (allow ?? deny);
}

export function denyOption(request: RequestPermissionRequest): PermissionOption | undefined {
  const options = request.options ?? [];
  return (
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always") ??
    options.at(-1)
  );
}

function permissionSummary(request: RequestPermissionRequest): string {
  return oneLine(
    request.toolCall?.title ?? request.toolCall?.toolCallId ?? "The agent needs approval",
  );
}

function permissionDetail(request: RequestPermissionRequest): string {
  const raw = request.toolCall?.rawInput;
  if (raw && Object.keys(raw).length > 0) return JSON.stringify(raw, null, 2);
  const locations = request.toolCall?.locations ?? [];
  if (locations.length > 0) return locations.map((l) => l.path).join("\n");
  return "(the agent sent no further detail)";
}

function showNextPermission(): void {
  if (modalRequestId !== null || screen !== "main") return;
  const next = permissionQueue[0];
  if (!next) return;

  modalRequestId = next.requestId;
  const { request } = next;

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.id = "permission-modal";
  scrim.innerHTML = `
    <div class="modal">
      <div class="kicker">Permission needed</div>
      <div class="summary">${escapeHtml(permissionSummary(request))}</div>
      <div class="detail" id="perm-detail">${escapeHtml(permissionDetail(request))}</div>
      <div class="options" id="perm-options"></div>
    </div>
  `;
  app.append(scrim);

  const detail = scrim.querySelector<HTMLElement>("#perm-detail")!;
  focus.register(detail, {
    layer: "permission",
    priority: 0,
    onKey: scrollerKeyHandler(detail, 160),
  });

  const optionsEl = scrim.querySelector<HTMLElement>("#perm-options")!;
  const preferred = defaultOption(request);

  // Options are rendered in the order the agent gave them, with its own `kind`
  // driving the colour. Couchmode never adds an option the agent did not offer.
  request.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.className = "option";
    button.dataset.kind = option.kind;
    button.textContent = option.name;
    optionsEl.append(button);
    focus.register(button, {
      layer: "permission",
      priority: index + 1,
      onEnter: () => client.decidePermission(next.requestId, option.optionId),
    });
  });

  focus.pushLayer("permission");
  const preferredIndex = request.options.findIndex((o) => o.optionId === preferred?.optionId);
  const preferredButton = optionsEl.children[preferredIndex >= 0 ? preferredIndex : 0];
  if (preferredButton instanceof HTMLElement) focus.focus(preferredButton);

  // Back is the deny option, not a way to dismiss an unanswered request.
  // handleBack() below routes to this while a modal is up.
}

function closePermission(requestId: string, optionId: string | null, by: string): void {
  const index = permissionQueue.findIndex((entry) => entry.requestId === requestId);
  if (index >= 0) permissionQueue.splice(index, 1);
  if (modalRequestId !== requestId) return;

  const scrim = app.querySelector<HTMLElement>("#permission-modal");
  const request = scrim?.querySelector<HTMLElement>(".modal");
  if (scrim && request) {
    // Briefly show who answered - on a shared screen that matters.
    const label = optionId ? `“${optionId}” · answered on ${by}` : `cancelled`;
    request.innerHTML = `<div class="resolved">✓ ${escapeHtml(label)}</div>`;
  }

  window.setTimeout(() => {
    focus.popLayer();
    app.querySelector("#permission-modal")?.remove();
    modalRequestId = null;
    showNextPermission();
  }, 900);
}

/**
 * Wipe everything belonging to the previous ACP session.
 *
 * Tearing down the overlays matters as much as clearing the transcript: a
 * permission modal left on screen holds a focus layer and its `requestId`, so
 * the remote would be stuck behind a dialog describing a session that has
 * ended, and no later request could ever be shown.
 */
function resetForNewSession(): void {
  app.querySelector("#permission-modal")?.remove();
  app.querySelector("#agent-picker")?.remove();
  pickerOpen = false;
  modalRequestId = null;
  permissionQueue.length = 0;
  focus.setBackHandler(() => handleBack());
  focus.resetToBase();

  transcript.clear();
  if (feedEl) feedEl.innerHTML = `<div class="empty">Starting a new session…</div>`;
  autoScroll = true;
  statusDetail = "";
  paintDiff();
  paintTopbar();
}

// --------------------------------------------------------- agent picker

let pickerOpen = false;

/**
 * Pick a different agent from `agents.json`.
 *
 * Switching ends the ACP session - a session belongs to the agent that created
 * it - so the bridge replies with `session_reset` and the transcript is
 * cleared. The picker says so rather than letting it be a surprise.
 */
function openAgentPicker(): void {
  if (pickerOpen || screen !== "main" || modalRequestId !== null) return;
  const agents = hello?.agents ?? [];
  if (agents.length === 0) return;
  pickerOpen = true;

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.id = "agent-picker";
  scrim.innerHTML = `
    <div class="modal picker">
      <div class="kicker">Agent</div>
      <div class="summary">Which agent should run?</div>
      <div class="picker-note">Switching starts a new session. Everything on screen is cleared.</div>
      <div class="options picker-options" id="agent-options"></div>
    </div>
  `;
  app.append(scrim);

  const optionsEl = scrim.querySelector<HTMLElement>("#agent-options")!;
  agents.forEach((agent: AgentSummary, index) => {
    const button = document.createElement("button");
    button.className = "option agent-option";
    button.dataset.active = String(agent.active);
    button.textContent = agent.active ? `${agent.title} · restart` : agent.title;
    optionsEl.append(button);
    focus.register(button, {
      layer: "picker",
      priority: index,
      onEnter: () => {
        // Choosing the running agent restarts it, which is worth having when
        // one has wedged.
        client.switchAgent(agent.name);
        closeAgentPicker();
      },
    });
  });

  focus.pushLayer("picker");
  const activeIndex = agents.findIndex((agent) => agent.active);
  const start = optionsEl.children[activeIndex >= 0 ? activeIndex : 0];
  if (start instanceof HTMLElement) focus.focus(start);
}

function closeAgentPicker(): void {
  if (!pickerOpen) return;
  pickerOpen = false;
  focus.popLayer();
  app.querySelector("#agent-picker")?.remove();
}

// ----------------------------------------------------------------- wiring

/**
 * What Back does, in one place.
 *
 * Returns true when the page consumed it. The Fire TV shell calls this through
 * `window.couchmodeBack()` and only finishes the activity when it returns
 * false, so Back closes what is open before it ever leaves the app.
 */
export function handleBack(): boolean {
  if (pickerOpen) {
    closeAgentPicker();
    return true;
  }
  if (composerOpen) {
    // Back cancels the composer, which is what it means everywhere else.
    //
    // On Fire TV this branch is rarely reached: while the on-screen keyboard is
    // attached it consumes Back itself and commits the text, which the page
    // receives as Enter - so Back there ends up submitting rather than
    // cancelling. See docs/firetv-notes.md.
    closeComposer();
    return true;
  }
  const requestId = modalRequestId;
  if (requestId !== null) {
    // Back answers a permission request with its deny option. It is never a way
    // to dismiss one unanswered: the agent is blocked until we reply.
    const entry = permissionQueue.find((item) => item.requestId === requestId);
    const deny = entry ? denyOption(entry.request) : undefined;
    if (deny) client.decidePermission(requestId, deny.optionId);
    return true;
  }
  if (screen === "main" && feedEl && focus.focused !== feedEl) {
    // Otherwise Back returns to the top of the screen, the way Back behaves
    // everywhere else on a TV, rather than dropping out of the app.
    focus.focus(feedEl);
    return true;
  }
  return false;
}

focus.setBackHandler(() => handleBack());

document.addEventListener(
  "keydown",
  (event) => {
    if (composerOpen) {
      // The composer handles its own keys; only Back escapes to us.
      return;
    }
    if (focus.handleKey(event)) event.preventDefault();
  },
  true,
);

declare global {
  interface Window {
    /** Called by the Fire TV shell on KEYCODE_BACK. See handleBack(). */
    couchmodeBack?: () => boolean;
    /** True once the main screen is up, so the shell can tell pairing apart. */
    couchmodeReady?: () => boolean;
  }
}

window.couchmodeBack = handleBack;
window.couchmodeReady = () => screen === "main";

client.on("state", (state: ConnectionState) => {
  if (state === "rejected") {
    renderPairing("That code didn't match. Check your terminal and try again.");
    return;
  }
  if (state === "paired" && screen !== "main") renderMain();
  paintTopbar();
});

client.on("message", (message: ServerMessage) => {
  switch (message.type) {
    case "hello":
      hello = message;
      status = message.status;
      if (screen !== "main") renderMain();
      paintTopbar();
      break;
    case "agent_status":
      status = message.status;
      statusDetail = message.detail ?? "";
      paintTopbar();
      break;
    case "acp":
      transcript.apply(message.payload.update);
      break;
    case "session_reset":
      resetForNewSession();
      break;
    case "permission_request":
      permissionQueue.push({ requestId: message.requestId, request: message.request });
      showNextPermission();
      break;
    case "permission_resolved":
      closePermission(message.requestId, message.optionId, message.by);
      break;
    case "prompt_draft":
      paintPromptField(message.text, message.from);
      break;
    case "error":
      statusDetail = message.message;
      paintTopbar();
      break;
  }
});

renderPairing();
