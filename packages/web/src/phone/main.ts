/**
 * /phone - keyboard and secondary approval device.
 *
 * Pairs with the bridge, streams the agent's output, and answers ACP permission
 * requests. Permission options are rendered from the agent's own `options[]`;
 * Couchmode never invents an option the agent did not offer.
 */
import { CouchmodeClient } from "../shared/client.js";
import type { ConnectionState } from "../shared/client.js";
import type {
  AgentStatus,
  HelloMessage,
  PermissionOption,
  RequestPermissionRequest,
  ServerMessage,
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
    </header>
    <div class="banner" id="banner" hidden></div>
    <main id="feed"><div class="empty">Ask the agent something to get started.</div></main>
    <div class="permissions" id="permissions"></div>
    <footer>
      <textarea id="input" rows="1" placeholder="Ask the agent…"></textarea>
      <button class="icon-button" id="mic" title="Dictate" hidden>🎤</button>
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

  setupVoice();
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
  if (project && hello) project.textContent = hello.projectName;
  if (branch && hello) {
    const parts = [hello.agentTitle];
    if (hello.gitBranch) parts.unshift(hello.gitBranch);
    if (hello.fake) parts.push("fake");
    branch.textContent = parts.join(" · ");
  }
  if (pill) {
    pill.textContent = STATUS_LABEL[status];
    pill.dataset.status = status;
  }
  const agentSwitch = app.querySelector<HTMLButtonElement>("#agent-switch");
  if (agentSwitch && hello) {
    // Only worth offering when there is something to switch to.
    agentSwitch.hidden = hello.agents.length < 2 || hello.fake;
    agentSwitch.textContent = hello.agentTitle;
  }
  if (bannerEl) {
    const offline = client.connectionState === "offline" || client.connectionState === "connecting";
    const text = offline ? "Reconnecting to the bridge…" : statusDetail;
    bannerEl.hidden = text.length === 0;
    bannerEl.textContent = text;
    bannerEl.classList.toggle("offline", offline);
  }
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
    <div class="detail">Switching starts a new session and clears this transcript.</div>
    <div class="options"></div>
  `;
  const options = sheet.querySelector<HTMLElement>(".options")!;
  for (const agent of agents) {
    const button = document.createElement("button");
    button.className = "option";
    button.dataset.kind = agent.active ? "allow_once" : "";
    button.textContent = agent.active ? `${agent.title} · restart` : agent.title;
    button.addEventListener("click", () => {
      client.switchAgent(agent.name);
      sheet.remove();
    });
    options.append(button);
  }
  permissionsEl?.prepend(sheet);
}

// --- Web Speech API (optional) ---------------------------------------------

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/**
 * Whether in-page dictation can actually work here.
 *
 * The Speech API object exists on an insecure origin but is useless: browsers
 * strip microphone access outside a secure context, and `navigator.mediaDevices`
 * is undefined. Couchmode is served over plain HTTP on the LAN by design, so on
 * a phone this is normally false - and showing a button that can never work is
 * worse than showing none.
 *
 * It is true when the page is opened over localhost or HTTPS.
 */
export function speechAvailable(): boolean {
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const hasApi = Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  return hasApi && window.isSecureContext;
}

function setupVoice(): void {
  const mic = app.querySelector<HTMLButtonElement>("#mic");
  if (!mic) return;

  if (!speechAvailable()) {
    // Every phone keyboard has its own dictation key, and that one works on any
    // origin because it belongs to the OS rather than the page.
    mic.hidden = true;
    if (textareaEl) {
      textareaEl.placeholder = "Ask the agent… (tap 🎤 on your keyboard to dictate)";
    }
    return;
  }

  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Recognition = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;

  mic.hidden = false;
  let recognition: SpeechRecognitionLike | null = null;

  const finish = () => {
    recognition = null;
    mic.classList.remove("recording");
  };

  mic.addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    const instance = new Recognition();
    recognition = instance;
    instance.lang = navigator.language || "en-US";
    instance.interimResults = true;
    instance.continuous = false;
    instance.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript ?? "";
      }
      if (textareaEl) textareaEl.value = text;
    };
    instance.onend = finish;
    // Without this a refused microphone fails silently and the button just
    // sits there looking broken.
    instance.onerror = (event) => {
      finish();
      statusDetail = `Dictation stopped: ${event.error ?? "unknown error"}. You can tap 🎤 on your keyboard instead.`;
      paintHeader();
    };
    mic.classList.add("recording");
    try {
      instance.start();
    } catch (error) {
      finish();
      statusDetail = `Dictation could not start: ${(error as Error).message}`;
      paintHeader();
    }
  });
}

// --- wiring -----------------------------------------------------------------

client.on("state", (state: ConnectionState) => {
  if (state === "rejected") {
    showPairing("That code didn't match. Check your terminal and try again.");
    return;
  }
  if (state === "paired" && !document.querySelector("#feed")) showMain();
  paintHeader();
});

client.on("message", (message: ServerMessage) => {
  switch (message.type) {
    case "hello":
      hello = message;
      status = message.status;
      if (!document.querySelector("#feed")) showMain();
      paintHeader();
      break;
    case "agent_status":
      status = message.status;
      statusDetail = message.detail ?? "";
      paintHeader();
      break;
    case "acp":
      transcript.apply(message.payload.update);
      break;
    case "session_reset":
      transcript.clear();
      pending.clear();
      app.querySelector("#agent-sheet")?.remove();
      if (feedEl) feedEl.innerHTML = `<div class="empty">Starting a new session…</div>`;
      repaintPermissions();
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
