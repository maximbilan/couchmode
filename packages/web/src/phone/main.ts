/**
 * /phone - keyboard and secondary approval device.
 *
 * Pairs with the bridge, streams the agent's output, and answers ACP permission
 * requests. Permission options are rendered from the agent's own `options[]`;
 * Couchmode never invents an option the agent did not offer.
 */
import { connectionLabel, CouchmodeClient } from "../shared/client.js";
import type { ConnectionStatus } from "../shared/client.js";
import type {
  AgentStatus,
  HelloMessage,
  PermissionOption,
  RequestPermissionRequest,
  ServerMessage,
  SessionResetMessage,
} from "../shared/protocol.js";
import { escapeHtml, renderMarkdown, toolKindIcon, TranscriptModel } from "../shared/render.js";
import type { TranscriptItem } from "../shared/render.js";

const STORAGE_KEY = "couchmode.phone.code";

const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: "Starting",
  ready: "Ready",
  prompting: "Thinking",
  waiting_permission: "Needs approval",
  error: "Error",
  exited: "Agent exited",
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const client = new CouchmodeClient("phone");

let hello: HelloMessage | null = null;
let status: AgentStatus = "starting";
let statusDetail = "";
const pending = new Map<string, RequestPermissionRequest>();

/** The agent a requested switch is starting, until its session is running. */
let switching: { name: string; title: string } | null = null;

/** A short-lived line in the banner: "Reconnected", "Claude is running". */
let notice: { text: string; tone: "good" | "info" } | null = null;
let noticeTimer: number | null = null;

function flashNotice(text: string, tone: "good" | "info" = "info", ms = 4_000): void {
  notice = { text, tone };
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice = null;
    noticeTimer = null;
    paintHeader();
  }, ms);
  paintHeader();
}

/**
 * Repaint the "retrying in 4s" countdown.
 *
 * While the link is down nothing arrives to trigger a repaint, so the only
 * alternative to a timer is a banner that says "disconnected" and then sits
 * there looking identical whether or not anything is being attempted.
 */
let countdownTimer: number | null = null;

function syncCountdown(): void {
  const needed = client.connectionStatus.state === "offline";
  if (needed && countdownTimer === null) {
    countdownTimer = window.setInterval(paintHeader, 1_000);
  } else if (!needed && countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// --- pairing screen ---------------------------------------------------------

function showPairing(message = ""): void {
  const codeFromUrl = new URL(location.href).searchParams.get("code");
  const saved = codeFromUrl ?? localStorage.getItem(STORAGE_KEY) ?? "";

  app.innerHTML = `
    <section class="pair">
      <h1>Couchmode</h1>
      <p>Enter the 6-digit code shown in your terminal.</p>
      <input class="code-input" id="code" inputmode="numeric" autocomplete="one-time-code"
             maxlength="6" placeholder="000000" value="${escapeHtml(saved)}" />
      <button class="primary" id="pair">Pair</button>
      <div class="pair-error" id="pair-error">${escapeHtml(message)}</div>
    </section>
  `;

  const input = app.querySelector<HTMLInputElement>("#code")!;
  const button = app.querySelector<HTMLButtonElement>("#pair")!;

  const submit = () => {
    const code = input.value.trim();
    if (code.length === 0) return;
    localStorage.setItem(STORAGE_KEY, code);
    client.connect(code);
    button.disabled = true;
    button.textContent = "Pairing…";
  };

  button.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  input.focus();

  if (saved && codeFromUrl) submit();
}

// --- main screen ------------------------------------------------------------

let feedEl: HTMLElement | null = null;
let permissionsEl: HTMLElement | null = null;
let textareaEl: HTMLTextAreaElement | null = null;
let bannerEl: HTMLElement | null = null;

const transcript = new TranscriptModel({
  onAdd: (item, index) => {
    if (!feedEl) return;
    const empty = feedEl.querySelector(".empty");
    empty?.remove();
    const node = document.createElement("div");
    node.dataset.index = String(index);
    node.innerHTML = "";
    feedEl.append(node);
    paintItem(node, item);
    autoScroll();
  },
  onUpdate: (item, index) => {
    const node = feedEl?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (node) {
      paintItem(node, item);
      autoScroll();
    }
  },
  onIgnored: (type, reason) => console.debug(`[couchmode] ignoring ${type}: ${reason}`),
});

function paintItem(node: HTMLElement, item: TranscriptItem): void {
  switch (item.kind) {
    case "message":
      node.className = `item ${item.role}`;
      node.innerHTML = renderMarkdown(item.text);
      break;
    case "thought":
      node.className = "item thought";
      node.textContent = item.text;
      break;
    case "tool_call":
      node.className = "tool";
      node.dataset.status = item.call.status;
      node.innerHTML = `
        <span>${toolKindIcon(item.call.toolKind)}</span>
        <span class="title">${escapeHtml(item.call.title)}</span>
        <span class="status">${escapeHtml(item.call.status.replace("_", " "))}</span>
      `;
      break;
    case "plan":
      node.className = "plan";
      node.innerHTML =
        `<h3>Plan</h3>` +
        item.entries
          .map(
            (entry) =>
              `<div class="entry" data-status="${escapeHtml(entry.status ?? "pending")}">${escapeHtml(entry.content)}</div>`,
          )
          .join("");
      break;
  }
}

function autoScroll(): void {
  if (!feedEl) return;
  const nearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 180;
  if (nearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

function showMain(): void {
  app.innerHTML = `
    <header>
      <div>
        <div class="project" id="project">…</div>
        <div class="branch" id="branch"></div>
      </div>
      <button class="pill agent-pill" id="agent-switch" hidden>Agent</button>
      <div class="pill" id="status">Starting</div>
      <div class="pill link-pill" id="link" data-link="connecting">Connecting…</div>
    </header>
    <div class="banner" id="banner" hidden></div>
    <main id="feed"><div class="empty">Ask the agent something to get started.</div></main>
    <div class="permissions" id="permissions"></div>
    <footer>
      <textarea id="input" rows="1" placeholder="Ask the agent…"></textarea>
      <button class="send" id="send">Send</button>
    </footer>
  `;

  feedEl = app.querySelector<HTMLElement>("#feed");
  permissionsEl = app.querySelector<HTMLElement>("#permissions");
  bannerEl = app.querySelector<HTMLElement>("#banner");
  textareaEl = app.querySelector<HTMLTextAreaElement>("#input");

  const send = app.querySelector<HTMLButtonElement>("#send")!;
  send.addEventListener("click", submitPrompt);

  app
    .querySelector<HTMLButtonElement>("#agent-switch")
    ?.addEventListener("click", toggleAgentPicker);

  textareaEl?.addEventListener("input", () => {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 140)}px`;
  });
  textareaEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitPrompt();
    }
  });

  paintHeader();
  repaintPermissions();

  // Repaint the transcript in case updates arrived during replay.
  for (const [index, item] of transcript.items.entries()) {
    const node = document.createElement("div");
    node.dataset.index = String(index);
    feedEl?.append(node);
    paintItem(node, item);
  }
  if (transcript.items.length > 0) feedEl?.querySelector(".empty")?.remove();
  autoScroll();
}

function submitPrompt(): void {
  const text = textareaEl?.value.trim() ?? "";
  if (text.length === 0) return;
  client.submitPrompt(text);
  if (textareaEl) {
    textareaEl.value = "";
    textareaEl.style.height = "auto";
  }
}

function paintHeader(): void {
  const project = app.querySelector<HTMLElement>("#project");
  const branch = app.querySelector<HTMLElement>("#branch");
  const pill = app.querySelector<HTMLElement>("#status");
  const link = app.querySelector<HTMLElement>("#link");
  const connection = client.connectionStatus;
  const live = connection.state === "paired";

  if (project && hello) project.textContent = hello.projectName;
  if (branch && hello) {
    // While a switch is in flight, name the agent being started: the corrected
    // `hello` is seconds away and until then this would show the old one.
    const parts = [switching ? `${switching.title} · starting…` : hello.agentTitle];
    if (hello.gitBranch) parts.unshift(hello.gitBranch);
    if (hello.fake) parts.push("fake");
    branch.textContent = parts.join(" · ");
  }
  if (pill) {
    pill.textContent = STATUS_LABEL[status];
    pill.dataset.status = status;
    // Offline, the last status we heard is a claim about the past.
    pill.dataset.stale = String(!live);
  }
  if (link) {
    link.textContent = connectionLabel(connection);
    link.dataset.link = connection.state;
  }

  const agentSwitch = app.querySelector<HTMLButtonElement>("#agent-switch");
  if (agentSwitch && hello) {
    // Only worth offering when there is something to switch to.
    agentSwitch.hidden = hello.agents.length < 2 || hello.fake;
    agentSwitch.textContent = switching ? `${switching.title}…` : hello.agentTitle;
    agentSwitch.disabled = Boolean(switching) || !live;
  }

  const send = app.querySelector<HTMLButtonElement>("#send");
  // A prompt sent while the socket is down goes nowhere. Say so on the button
  // rather than swallowing it.
  if (send) send.disabled = !live;

  if (bannerEl) {
    let text = "";
    let tone = "";
    if (!live && connection.state !== "idle") {
      text = connection.everPaired
        ? `Lost the bridge — ${connectionLabel(connection).replace(/^[^·]*· /, "")}${connection.attempt > 1 ? ` (attempt ${connection.attempt})` : ""}. The agent keeps working; this screen is from before the drop.`
        : `${connectionLabel(connection)} — check the bridge is still running.`;
      tone = "offline";
    } else if (notice) {
      text = notice.text;
      tone = notice.tone;
    } else {
      text = statusDetail;
      tone = statusDetail ? "bad" : "";
    }
    bannerEl.hidden = text.length === 0;
    bannerEl.textContent = text;
    bannerEl.className = `banner${tone ? ` ${tone}` : ""}`;
  }

  syncCountdown();
}

/**
 * Build the one-line summary for a permission request from the ACP tool call.
 * Falls back through title -> toolCallId so there is always something readable.
 */
function permissionSummary(request: RequestPermissionRequest): string {
  return request.toolCall?.title ?? request.toolCall?.toolCallId ?? "The agent needs approval";
}

function permissionDetail(request: RequestPermissionRequest): string {
  const raw = request.toolCall?.rawInput;
  if (raw && Object.keys(raw).length > 0) return JSON.stringify(raw, null, 2);
  const locations = request.toolCall?.locations ?? [];
  if (locations.length > 0) return locations.map((l) => l.path).join("\n");
  return "";
}

function repaintPermissions(): void {
  if (!permissionsEl) return;
  permissionsEl.innerHTML = "";
  for (const [requestId, request] of pending) {
    const node = document.createElement("div");
    node.className = "permission";
    node.innerHTML = `
      <div class="summary">${escapeHtml(permissionSummary(request))}</div>
      <div class="detail">${escapeHtml(permissionDetail(request))}</div>
      <div class="options"></div>
    `;
    const options = node.querySelector<HTMLElement>(".options")!;
    // Render the agent's options in the order given, using the ACP `kind` hint.
    for (const option of request.options as PermissionOption[]) {
      const button = document.createElement("button");
      button.className = "option";
      button.dataset.kind = option.kind;
      button.textContent = option.name;
      button.addEventListener("click", () => client.decidePermission(requestId, option.optionId));
      options.append(button);
    }
    permissionsEl.append(node);
  }
}

// --- agent picker -----------------------------------------------------------

/**
 * Switching agents ends the ACP session, because a session belongs to the agent
 * that created it. The sheet says so before you pick.
 */
function toggleAgentPicker(): void {
  const existing = app.querySelector("#agent-sheet");
  if (existing) {
    existing.remove();
    return;
  }
  const agents = hello?.agents ?? [];
  if (agents.length === 0) return;

  const sheet = document.createElement("div");
  sheet.className = "permission";
  sheet.id = "agent-sheet";
  sheet.innerHTML = `
    <div class="summary">Run a different agent</div>
    <div class="detail">Switching starts a new session with that agent. This one ends — a session belongs to the agent that created it — so this transcript and any pending approvals are cleared.</div>
    <div class="options"></div>
    <div class="sheet-state" id="sheet-state" hidden></div>
  `;
  const options = sheet.querySelector<HTMLElement>(".options")!;
  for (const agent of agents) {
    const button = document.createElement("button");
    button.className = "option agent-option";
    button.dataset.kind = agent.active ? "allow_once" : "";
    button.innerHTML = `
      <span class="agent-name">${escapeHtml(agent.active ? `${agent.title} · restart` : agent.title)}</span>
      <span class="agent-command">${escapeHtml(agent.command)}</span>
    `;
    button.addEventListener("click", () => {
      client.switchAgent(agent.name);
      switching = { name: agent.name, title: agent.title };
      // The sheet stays up in a starting state. Closing it on the click would
      // leave several seconds where nothing on screen has changed yet.
      options.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const state = sheet.querySelector<HTMLElement>("#sheet-state");
      if (state) {
        state.hidden = false;
        state.textContent = agent.active
          ? `Restarting ${agent.title}…`
          : `Starting ${agent.title}…`;
      }
      paintHeader();
    });
    options.append(button);
  }
  permissionsEl?.prepend(sheet);
}

/** A rule across the feed marking where one session ends and the next begins. */
function appendSessionMark(title: string, detail: string): void {
  if (!feedEl) return;
  feedEl.querySelector(".empty")?.remove();
  const node = document.createElement("div");
  node.className = "session-mark";
  node.innerHTML = `<div class="mark-title">◆ ${escapeHtml(title)}</div><div class="mark-detail">${escapeHtml(detail)}</div>`;
  feedEl.append(node);
  feedEl.scrollTop = feedEl.scrollHeight;
}

/** Drop everything that belonged to the session that just ended. */
function clearSessionState(): void {
  transcript.clear();
  pending.clear();
  app.querySelector("#agent-sheet")?.remove();
  if (feedEl) feedEl.innerHTML = "";
  repaintPermissions();
}

function resetForNewSession(message: SessionResetMessage): void {
  clearSessionState();
  switching = { name: message.agentName, title: message.agentTitle };
  statusDetail = "";
  const switched = message.reason === "agent_switched";
  appendSessionMark(
    switched ? `New session · ${message.agentTitle}` : `${message.agentTitle} restarted`,
    switched && message.previousTitle
      ? `Switched from ${message.previousTitle}. The old session ended with it.`
      : "Same agent, fresh session. Nothing from before carries over.",
  );
  paintHeader();
}

/** Whether the transcript being replaced by a replay had anything in it. */
let hadTranscriptBeforeReplay = false;

/**
 * The bridge is about to replay its buffer, so rebuild rather than append.
 *
 * Reconnecting re-pairs, and pairing always replays the session so far. Without
 * this, every reconnect leaves a second copy of the whole transcript and a
 * duplicate card for each pending approval.
 */
function resyncFromReplay(): void {
  hadTranscriptBeforeReplay = transcript.items.length > 0;
  clearSessionState();
}

/**
 * The replay is complete: settle the feed.
 *
 * The replay count includes `agent_status` messages, so a bridge that has only
 * reported "ready" still replays messages that produce no transcript - keying
 * the empty state off that count leaves a blank feed instead of the invitation
 * to ask something.
 */
function settleAfterReplay(): void {
  if (!feedEl) return;
  if (transcript.items.length === 0) {
    feedEl.innerHTML = `<div class="empty">Ask the agent something to get started.</div>`;
  } else if (hadTranscriptBeforeReplay) {
    appendSessionMark("Reconnected", "Caught up with everything the bridge buffered.");
  }
  hadTranscriptBeforeReplay = false;
  feedEl.scrollTop = feedEl.scrollHeight;
}

// --- wiring -----------------------------------------------------------------

client.on("status", (connection: ConnectionStatus) => {
  if (connection.state === "rejected") {
    showPairing("That code didn't match. Check your terminal and try again.");
    return;
  }
  if (connection.state === "paired" && !document.querySelector("#feed")) showMain();
  if (document.querySelector("#feed")) paintHeader();
  syncCountdown();
});

/** Reconnecting re-pairs, and pairing replays: rebuild instead of appending. */
client.on("replayStart", () => resyncFromReplay());
client.on("replayEnd", () => settleAfterReplay());

client.on("message", (message: ServerMessage) => {
  switch (message.type) {
    case "hello":
      hello = message;
      status = message.status;
      if (!document.querySelector("#feed")) showMain();
      // The switch is done once the bridge names the new agent as the running
      // one and it is past "starting".
      if (switching && message.agentName === switching.name && message.status !== "starting") {
        const title = message.agentInfo?.title ?? message.agentTitle;
        const version = message.agentInfo?.version ? ` ${message.agentInfo.version}` : "";
        switching = null;
        app.querySelector("#agent-sheet")?.remove();
        flashNotice(`${title}${version} is running — new session.`, "good");
      }
      paintHeader();
      break;
    case "agent_status":
      status = message.status;
      statusDetail = message.detail ?? "";
      if (switching && (message.status === "error" || message.status === "exited")) {
        // A failed switch must not leave the sheet claiming to be starting.
        const state = app.querySelector<HTMLElement>("#sheet-state");
        if (state) state.textContent = message.detail || `${switching.title} failed to start.`;
        switching = null;
      }
      paintHeader();
      break;
    case "acp":
      transcript.apply(message.payload.update);
      break;
    case "session_reset":
      resetForNewSession(message);
      break;
    case "permission_request":
      pending.set(message.requestId, message.request);
      repaintPermissions();
      break;
    case "permission_resolved":
      pending.delete(message.requestId);
      repaintPermissions();
      break;
    case "error":
      statusDetail = message.message;
      paintHeader();
      break;
  }
});

showPairing();
