/**
 * /tv - the 10-foot UI.
 *
 * Everything here is reachable with four arrows, Enter and Back. There is no
 * pointer and no tab order: focus moves by geometry via the shared
 * FocusManager, and a permission request pushes a focus layer so the feed
 * underneath cannot be reached by accident.
 */
import { connectionLabel, CouchmodeClient } from "../shared/client.js";
import type { ConnectionStatus } from "../shared/client.js";
import type {
  AgentStatus,
  AgentSummary,
  HelloMessage,
  PermissionOption,
  RequestPermissionRequest,
  ServerMessage,
  SessionResetMessage,
  ToolCallContentDiff,
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
/**
 * `?code=` pairs by itself, but only once per page load. A rejection redraws
 * the pairing screen, and re-submitting the same code from there would loop
 * against the bridge as fast as it can answer.
 */
let urlCodeTried = false;
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

// ---------------------------------------------------------------- motion

/**
 * Whether the bridge is replaying its buffer.
 *
 * A replay rebuilds the whole session in one burst after a reconnect. None of
 * it is news, and dozens of rows sliding in at once would be noise, so nothing
 * that arrives during one animates.
 */
let replaying = false;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Play a one-shot CSS animation on `el`, keyed by its `data-motion` attribute.
 *
 * An attribute rather than a class because `paintItem` rewrites `className` on
 * every streamed chunk, which would cut an entrance off after a frame. The
 * attribute comes off when the element's own animation ends, so the same
 * motion can be played again later.
 */
function playMotion(el: HTMLElement, name: string): void {
  if (replaying) return;
  if (el.dataset.motion === name) {
    // Already mid-flight: restart it rather than let the second one vanish.
    delete el.dataset.motion;
    void el.offsetWidth;
  }
  el.dataset.motion = name;
  const done = (event: AnimationEvent) => {
    if (event.target !== el) return;
    el.removeEventListener("animationend", done);
    if (el.dataset.motion === name) delete el.dataset.motion;
  };
  el.addEventListener("animationend", done);
}

/**
 * A quick push on whatever OK was just pressed on.
 *
 * The remote gives no feedback of its own, and some answers take a round trip
 * to the bridge before anything else on screen changes. Scrolling panels are
 * left alone: a whole panel moving reads as a glitch, not a press. A nudge
 * down rather than a shrink, because scaling the prompt bar - 1700px wide -
 * makes the TV re-rasterise it.
 */
function pressFeedback(el: HTMLElement): void {
  if (reducedMotion.matches || el.classList.contains("scroller")) return;
  el.animate([{ transform: "none" }, { transform: "translateY(4px)" }, { transform: "none" }], {
    duration: 160,
    easing: "ease-out",
  });
}

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
    <section class="pairing" id="pairing">
      <h1>Couchmode</h1>
      <p class="tagline">Your coding agent, in couch mode.</p>
      <div class="code-boxes" id="boxes"></div>
      <p class="hint">Enter the code from your terminal · <kbd>▲▼</kbd> change · <kbd>◀▶</kbd> move · <kbd>OK</kbd> pair</p>
      <div class="pair-status" id="pair-status" hidden></div>
      <div class="error" id="pair-error">${escapeHtml(message)}</div>
    </section>
  `;

  const boxes = app.querySelector<HTMLElement>("#boxes")!;
  // A wrong code shakes the boxes - the universal "no" - rather than only
  // printing a sentence under them.
  playMotion(app.querySelector<HTMLElement>("#pairing")!, message ? "reject" : "enter");
  const submit = () => {
    const code = digits.join("");
    localStorage.setItem(STORAGE_KEY, code);
    client.connect(code);
  };

  digits.forEach((_, index) => {
    const box = document.createElement("div");
    box.className = "digit";
    box.style.setProperty("--i", String(index));
    box.innerHTML = `<span class="value">${digits[index]}</span><span class="arrows">▲▼</span>`;
    boxes.append(box);

    focus.register(box, {
      priority: index,
      onEnter: submit,
      // Up/down cycle the digit; left/right fall through to spatial movement.
      onKey: (key) => {
        if (key !== "up" && key !== "down") return false;
        digits[index] = (digits[index]! + (key === "up" ? 1 : 9)) % 10;
        const value = box.querySelector<HTMLElement>(".value")!;
        value.textContent = String(digits[index]);
        // The new digit rolls in from the direction it came from, like a
        // combination lock.
        playMotion(value, key);
        return true;
      },
    });
  });

  focus.focusFirstInLayer();
  paintPairingStatus();
  if (fromUrl && !urlCodeTried) {
    urlCodeTried = true;
    submit();
  }
}

/** The pairing screen says what the socket is doing, not just "nothing yet". */
function paintPairingStatus(): void {
  const el = app.querySelector<HTMLElement>("#pair-status");
  if (!el) return;
  const { state } = client.connectionStatus;
  const busy = state === "connecting" || state === "reconnecting" || state === "pairing";
  const stuck = state === "offline";
  el.hidden = !busy && !stuck;
  el.textContent = connectionLabel(client.connectionStatus);
  el.classList.toggle("stuck", stuck);
}

// ------------------------------------------------------------------ feed

let feedEl: HTMLElement | null = null;
let diffBodyEl: HTMLElement | null = null;
let diffHeadEl: HTMLElement | null = null;

/**
 * Whether the feed is pinned to the newest item.
 *
 * Unpinning happens the moment the viewer scrolls up to read something, and
 * from then on the feed holds still while the agent keeps talking - which is
 * the point, but it also means what is on screen is no longer the present
 * tense. `#feed-jump` says so, and Back puts it back.
 */
let autoScroll = true;
/** Items that arrived while unpinned, for the jump chip's count. */
let missedItems = 0;

const transcript = new TranscriptModel({
  onAdd: (item, index) => {
    if (!feedEl) return;
    feedEl.querySelector(".empty")?.remove();
    const node = document.createElement("div");
    node.dataset.index = String(index);
    feedEl.append(node);
    paintItem(node, item);
    playMotion(node, "enter");
    if (!autoScroll) missedItems += 1;
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
    case "tool_call": {
      const previous = node.dataset.status;
      node.className = "tool";
      node.dataset.status = item.call.status;
      node.innerHTML = `
        <span class="icon">${toolKindIcon(item.call.toolKind)}</span>
        <span class="title">${escapeHtml(oneLine(item.call.title))}</span>
        <span class="status">${escapeHtml(item.call.status.replace("_", " "))}</span>
      `;
      // A tool finishing is where the agent's work lands. Mark the moment, so
      // a status word changing colour is not the only thing that happens.
      const settled = item.call.status === "completed" || item.call.status === "failed";
      if (previous !== undefined && previous !== item.call.status && settled) {
        playMotion(node, "settle");
      }
      break;
    }
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
  paintJumpChip();
  paintDiff();
  paintTopbar();
}

/** Re-pin the feed to the newest item. Back does this; so does the chip. */
function jumpToLatest(): void {
  if (!feedEl) return;
  autoScroll = true;
  missedItems = 0;
  feedEl.scrollTop = feedEl.scrollHeight;
  paintJumpChip();
}

function paintJumpChip(): void {
  const chip = app.querySelector<HTMLElement>("#feed-jump");
  if (!chip) return;
  chip.hidden = autoScroll;
  chip.textContent =
    missedItems > 0 ? `⇣ ${missedItems} new · Back` : "⇣ Back to jump to the latest";
}

// ------------------------------------------------------------------ diff

/** The diff currently drawn in the Changes panel. */
let shownDiff: ToolCallContentDiff | null = null;

function sameDiff(a: ToolCallContentDiff | null, b: ToolCallContentDiff): boolean {
  return a !== null && a.path === b.path && a.oldText === b.oldText && a.newText === b.newText;
}

function paintDiff(): void {
  if (!diffBodyEl || !diffHeadEl) return;
  const panel = app.querySelector<HTMLElement>("#diff-panel");
  const stage = app.querySelector<HTMLElement>("#stage");
  const diff = latestDiff(transcript.items);

  // An empty Changes panel is 40% of a television spent saying "nothing yet",
  // so it only exists once there is a diff to put in it. The feed takes the
  // whole width until then.
  if (!diff) {
    if (panel && !panel.hidden) {
      panel.hidden = true;
      // Focus cannot stay on a panel that is no longer on screen.
      if (diffBodyEl && focus.focused === diffBodyEl && feedEl) focus.focus(feedEl);
    }
    stage?.classList.add("stage-solo");
    diffBodyEl.innerHTML = "";
    shownDiff = null;
    return;
  }

  if (panel?.hidden) {
    panel.hidden = false;
    // The feed gives up 40% of the screen at this moment. Sliding the panel in
    // makes that read as the agent's change arriving, not the layout jumping.
    playMotion(panel, "enter");
  }
  stage?.classList.remove("stage-solo");

  // This runs on every streamed chunk. Re-diffing an unchanged file - an LCS
  // over every line - and redrawing 400 rows is wasted work on a TV stick, and
  // would replay the diff's entrance below on every chunk.
  if (sameDiff(shownDiff, diff)) return;
  shownDiff = diff;

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

  const block = diffBodyEl.firstElementChild;
  if (block instanceof HTMLElement) playMotion(block, "enter");
}

/** Keep the tail of a path: the filename matters more than the repo root. */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

// ------------------------------------------------------------- notices

/**
 * A short-lived line in the banner - "Reconnected", "Claude is ready".
 *
 * Things that end well are as worth saying as things that go wrong: without
 * this, coming back from a dropped connection or a switched agent is a banner
 * silently disappearing, which reads the same as the page having frozen.
 */
type NoticeTone = "good" | "info";
let notice: { text: string; tone: NoticeTone } | null = null;
let noticeTimer: number | null = null;

function flashNotice(text: string, tone: NoticeTone = "info", ms = 4_000): void {
  notice = { text, tone };
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice = null;
    noticeTimer = null;
    paintTopbar();
  }, ms);
  paintTopbar();
}

// --------------------------------------------------------------- top bar

/**
 * Repaint the countdown while the link is down.
 *
 * "Disconnected" on its own invites the question "is it trying?". A ticking
 * "retrying in 4s" answers it, which needs a repaint per second that nothing
 * else in the page would trigger - while offline there is, by definition, no
 * incoming traffic.
 */
let countdownTimer: number | null = null;

function syncCountdown(): void {
  const needed = client.connectionStatus.state === "offline";
  if (needed && countdownTimer === null) {
    countdownTimer = window.setInterval(() => {
      if (screen === "main") paintTopbar();
      else paintPairingStatus();
    }, 1_000);
  } else if (!needed && countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function paintTopbar(): void {
  const project = app.querySelector<HTMLElement>("#project");
  const branch = app.querySelector<HTMLElement>("#branch");
  const agent = app.querySelector<HTMLElement>("#agent");
  const pill = app.querySelector<HTMLElement>("#status");
  const link = app.querySelector<HTMLElement>("#link");
  const clients = app.querySelector<HTMLElement>("#clients");
  const banner = app.querySelector<HTMLElement>("#banner");
  const connection = client.connectionStatus;
  const live = connection.state === "paired";

  if (hello) {
    if (project) project.textContent = hello.projectName;
    if (branch) {
      branch.textContent = hello.gitBranch ?? "no branch";
      branch.hidden = false;
    }
    if (clients) {
      const tv = hello.clients.filter((c) => c.clientType === "tv").length;
      const phone = hello.clients.filter((c) => c.clientType === "phone").length;
      clients.textContent = `📺 ${tv}  📱 ${phone}`;
    }
  }

  if (agent) {
    // While a switch is in flight the top bar names the agent being started,
    // not the one that just went away: the corrected `hello` is seconds out.
    const title = switching?.title ?? hello?.agentInfo?.title ?? hello?.agentTitle ?? "";
    const suffix = switching ? " · starting…" : hello?.fake ? " · replay" : "";
    agent.textContent = `${title}${suffix}`;
    agent.dataset.switching = String(Boolean(switching));
  }

  if (pill) {
    pill.textContent = statusLabel();
    pill.dataset.status = status;
    // Offline, the last status we heard is a claim about the past. Dim it
    // rather than let "Thinking" imply the agent is thinking right now.
    pill.dataset.stale = String(!live);
  }

  if (link) {
    link.textContent = connectionLabel(connection);
    link.dataset.link = connection.state;
  }

  if (banner) {
    let text = "";
    let tone = "";
    if (!live && connection.state !== "idle") {
      text = connection.everPaired
        ? `Lost the bridge — ${connectionLabel(connection).replace(/^[^·]*· /, "")}${connection.attempt > 1 ? ` (attempt ${connection.attempt})` : ""}. Everything on screen is from before the drop; the agent keeps working without us.`
        : `${connectionLabel(connection)} — check that the bridge is still running on your machine.`;
      tone = "offline";
    } else if (notice) {
      text = notice.text;
      tone = notice.tone;
    } else {
      text = statusDetail;
      tone = statusDetail ? "bad" : "";
    }
    banner.hidden = text.length === 0;
    banner.textContent = text;
    banner.className = `banner${tone ? ` ${tone}` : ""}`;
  }

  syncCountdown();
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
      <span class="link-pill" id="link" data-link="connecting">Connecting…</span>
      <span class="clients" id="clients"></span>
    </div>
    <div class="banner" id="banner" hidden></div>
    <div class="stage" id="stage">
      <section class="panel">
        <div class="panel-head"><span>Activity</span></div>
        <div class="scroller feed" id="feed"><div class="empty">Ask the agent something to get started.</div></div>
        <div class="jump-chip" id="feed-jump" hidden></div>
      </section>
      <section class="panel" id="diff-panel" hidden>
        <div class="panel-head" id="diff-head"><span>Changes</span></div>
        <div class="scroller" id="diff"></div>
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
      <span><kbd>Back</kbd> jumps to the latest</span>
      <span><kbd>MENU</kbd> switches agent</span>
    </div>
  `;

  feedEl = app.querySelector<HTMLElement>("#feed");
  diffBodyEl = app.querySelector<HTMLElement>("#diff");
  diffHeadEl = app.querySelector<HTMLElement>("#diff-head");
  shownDiff = null;

  // Pairing worked: the screen assembles itself rather than cutting over, top
  // bar from above and controls from below.
  playMotion(app, "main");

  // Auto-scroll, unless the viewer has deliberately scrolled up to read.
  feedEl?.addEventListener("scroll", () => {
    if (!feedEl) return;
    const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
    if (pinned && !autoScroll) missedItems = 0;
    autoScroll = pinned;
    paintJumpChip();
  });

  // A pan up is an explicit decision to stop following the live tail. Saying so
  // here rather than waiting for the scroll event to be observed closes the gap
  // where an item arriving in between would re-pin the feed and drag the viewer
  // back down mid-read.
  const unpinOnPanUp = (key: "up" | "down") => {
    if (key === "up") autoScroll = false;
    paintJumpChip();
  };

  app.querySelector<HTMLElement>("#feed-jump")?.addEventListener("click", jumpToLatest);

  if (feedEl) {
    focus.register(feedEl, {
      priority: 0,
      // A page at a time, accelerating while the button is held: a transcript
      // that has run for an hour is otherwise a wall the remote cannot climb.
      onKey: scrollerKeyHandler(feedEl, { onPan: unpinOnPanUp }),
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
  jumpToLatest();
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
    // A prompt typed while the bridge is unreachable would be dropped on the
    // floor by `send()`, so say so instead of pretending it was sent.
    if (text.length > 0 && !client.isLive) {
      flashNotice("Not connected — that prompt was not sent. Try again once reconnected.", "info");
      closeComposer();
      return;
    }
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
  // The moment the whole product exists for: it rises in over a fading scrim.
  // Set directly rather than through playMotion: the scrim's own fade ends
  // first, and clearing the attribute then would cut the modal's rise short.
  if (!replaying) scrim.dataset.motion = "enter";
  // An edit's diff and its permission request arrive together, and the scrim
  // is about to cover the Changes panel. Finish the panel's entrance now: the
  // Fire TV has frames enough for one entrance at a time, not two.
  for (const el of app.querySelectorAll<HTMLElement>("#diff-panel, .diff")) {
    for (const animation of el.getAnimations()) animation.finish();
  }

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
  const chosenKind = permissionQueue[index]?.request.options.find(
    (option) => option.optionId === optionId,
  )?.kind;
  if (index >= 0) permissionQueue.splice(index, 1);
  if (modalRequestId !== requestId) return;

  const scrim = app.querySelector<HTMLElement>("#permission-modal");
  const request = scrim?.querySelector<HTMLElement>(".modal");
  if (scrim && request) {
    // Briefly show who answered - on a shared screen that matters.
    const label = optionId ? `“${optionId}” · answered on ${by}` : `cancelled`;
    const allowed = /^allow/.test(chosenKind ?? "");
    request.dataset.outcome = allowed ? "allow" : "reject";
    request.innerHTML = `<div class="resolved">${allowed ? "✓" : "✕"} ${escapeHtml(label)}</div>`;
    // Stamp the answer, hold it long enough to read, then fold the modal away
    // inside the same 900ms the dismissal below has always taken. Set directly,
    // not through playMotion: the fold must hold its last frame until the
    // element is removed, or the scrim flashes back for a frame first.
    if (!replaying) scrim.dataset.motion = "resolve";
  }

  window.setTimeout(() => {
    focus.popLayer();
    app.querySelector("#permission-modal")?.remove();
    modalRequestId = null;
    showNextPermission();
  }, 900);
}

/**
 * Drop every overlay and everything belonging to the old session state.
 *
 * Tearing down the overlays matters as much as clearing the transcript: a
 * permission modal left on screen holds a focus layer and its `requestId`, so
 * the remote would be stuck behind a dialog describing a session that has
 * ended, and no later request could ever be shown.
 */
function clearSessionState(): void {
  app.querySelector("#permission-modal")?.remove();
  app.querySelector("#agent-picker")?.remove();
  pickerOpen = false;
  modalRequestId = null;
  permissionQueue.length = 0;
  focus.setBackHandler(() => handleBack());
  focus.resetToBase();

  transcript.clear();
  if (feedEl) feedEl.innerHTML = "";
  autoScroll = true;
  missedItems = 0;
}

/** The bridge started a new ACP session under a (possibly different) agent. */
function resetForNewSession(message: SessionResetMessage): void {
  clearSessionState();
  switching = { name: message.agentName, title: message.agentTitle };
  statusDetail = "";

  const switched = message.reason === "agent_switched";
  appendSessionMark(
    switched ? `New session · ${message.agentTitle}` : `${message.agentTitle} restarted`,
    switched && message.previousTitle
      ? `Switched from ${message.previousTitle}. The old session ended with it — its transcript belonged to that agent, not to this one.`
      : "Same agent, fresh session. Nothing from before carries over.",
  );

  paintDiff();
  paintTopbar();
}

/** Whether the transcript being replaced by a replay had anything in it. */
let hadTranscriptBeforeReplay = false;

/**
 * The bridge is about to replay its buffer, so rebuild rather than append.
 *
 * Reconnecting re-pairs, and pairing always replays the session so far. Without
 * this the transcript grows a second copy of every message on every reconnect,
 * and each replayed permission request queues a duplicate modal.
 */
function resyncFromReplay(): void {
  hadTranscriptBeforeReplay = transcript.items.length > 0;
  clearSessionState();
}

/**
 * The replay is complete: settle the feed.
 *
 * What the feed should say can only be decided here, not at `replay_start`.
 * The replay count includes `agent_status` messages, so a bridge that has said
 * nothing but "ready" still replays a non-zero number of messages that produce
 * no transcript at all - and keying the empty state off that count leaves a
 * blank panel where the invitation to ask something should be.
 */
function settleAfterReplay(): void {
  if (!feedEl) return;
  if (transcript.items.length === 0) {
    feedEl.innerHTML = `<div class="empty">Ask the agent something to get started.</div>`;
  } else if (hadTranscriptBeforeReplay) {
    appendSessionMark("Reconnected", "Caught up with everything the bridge buffered.");
  }
  hadTranscriptBeforeReplay = false;
  paintDiff();
  paintTopbar();
  jumpToLatest();
}

/** A rule across the feed marking where one session ends and the next begins. */
function appendSessionMark(title: string, detail: string): void {
  if (!feedEl) return;
  feedEl.querySelector(".empty")?.remove();
  const node = document.createElement("div");
  node.className = "session-mark";
  node.innerHTML = `<div class="title">◆ ${escapeHtml(title)}</div><div class="detail">${escapeHtml(detail)}</div>`;
  feedEl.append(node);
  playMotion(node, "enter");
  jumpToLatest();
}

// --------------------------------------------------------- agent picker

let pickerOpen = false;
/** The agent a requested switch is starting, until its session is running. */
let switching: { name: string; title: string } | null = null;

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
  if (!replaying) scrim.dataset.motion = "enter";
  scrim.innerHTML = `
    <div class="modal picker">
      <div class="kicker">Agent</div>
      <div class="summary">Which agent should run?</div>
      <div class="picker-note">Switching starts a new session with that agent. This one ends — a session belongs to the agent that created it — so the transcript and any pending approvals are cleared.</div>
      <div class="options picker-options" id="agent-options"></div>
      <div class="picker-state" id="picker-state" hidden></div>
    </div>
  `;
  app.append(scrim);

  const optionsEl = scrim.querySelector<HTMLElement>("#agent-options")!;
  agents.forEach((agent: AgentSummary, index) => {
    const button = document.createElement("button");
    button.className = "option agent-option";
    button.dataset.active = String(agent.active);
    button.innerHTML = `
      <span class="agent-name">${escapeHtml(agent.title)}</span>
      <span class="agent-command">${escapeHtml(agent.command)}</span>
      <span class="agent-tag">${agent.active ? "running · restarts it" : "switch to this"}</span>
    `;
    optionsEl.append(button);
    focus.register(button, {
      layer: "picker",
      priority: index,
      onEnter: () => {
        // Choosing the running agent restarts it, which is worth having when
        // one has wedged.
        if (!client.isLive) {
          showPickerState(`Not connected — can't reach the bridge to start ${agent.title}.`, true);
          return;
        }
        client.switchAgent(agent.name);
        switching = { name: agent.name, title: agent.title };
        // Hold the picker open, in the starting state, instead of vanishing.
        // The bridge's `session_reset` closes it once the new session exists,
        // so the screen is never silently doing nothing.
        showPickerState(
          agent.active ? `Restarting ${agent.title}…` : `Starting ${agent.title}…`,
          false,
        );
        paintTopbar();
      },
    });
  });

  focus.pushLayer("picker");
  const activeIndex = agents.findIndex((agent) => agent.active);
  const start = optionsEl.children[activeIndex >= 0 ? activeIndex : 0];
  if (start instanceof HTMLElement) focus.focus(start);
}

/** Show progress inside the open picker rather than closing it on a guess. */
function showPickerState(text: string, isError: boolean): void {
  const state = app.querySelector<HTMLElement>("#picker-state");
  if (!state) return;
  state.hidden = false;
  state.textContent = text;
  state.classList.toggle("error", isError);
  const options = app.querySelector<HTMLElement>("#agent-options");
  if (!isError && options) options.classList.add("busy");
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
  if (screen === "main" && feedEl && !autoScroll) {
    // The escape hatch out of a long transcript. Scrolling up to read leaves
    // the remote somewhere in the middle of an hour of activity, and clawing
    // back to the controls one screen at a time is the single worst thing
    // about a D-pad. Back returns to the present in one press; the prompt bar
    // is then one press further down.
    jumpToLatest();
    focus.focus(feedEl);
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
    const target = focus.focused;
    if (focus.handleKey(event)) {
      event.preventDefault();
      if (target && toNavKey(event) === "enter") pressFeedback(target);
    }
  },
  true,
);

declare global {
  interface Window {
    /** Called by the Fire TV shell on KEYCODE_BACK. See handleBack(). */
    couchmodeBack?: () => boolean;
    /**
     * Called by the Fire TV shell on a short press of KEYCODE_MENU.
     *
     * The shell swallows MENU so Fire OS does not pop its own menu over the
     * app, which means the page never sees the key as a `keydown` - a browser
     * gets one through the focus manager, a television does not. This hook is
     * the device's only route to the agent picker.
     */
    couchmodeMenu?: () => boolean;
  }
}

window.couchmodeBack = handleBack;
window.couchmodeMenu = () => {
  openAgentPicker();
  return pickerOpen;
};

client.on("status", (connection: ConnectionStatus) => {
  // A link that drops mid-replay never sends its replayEnd.
  if (connection.state !== "paired") replaying = false;
  if (connection.state === "rejected") {
    renderPairing("That code didn't match. Check your terminal and try again.");
    return;
  }
  if (connection.state === "paired" && screen !== "main") renderMain();
  if (screen === "main") paintTopbar();
  else paintPairingStatus();
  syncCountdown();
});

/** Reconnecting re-pairs, and pairing replays: rebuild instead of appending. */
client.on("replayStart", () => {
  replaying = true;
  resyncFromReplay();
});
client.on("replayEnd", () => {
  replaying = false;
  settleAfterReplay();
});

client.on("message", (message: ServerMessage) => {
  switch (message.type) {
    case "hello": {
      const previous = hello;
      hello = message;
      status = message.status;
      if (screen !== "main") renderMain();
      // The switch is done once the bridge names the new agent as the running
      // one. Say so out loud: a picker that closed and a top bar that changed
      // are easy to miss from across a room.
      if (switching && message.agentName === switching.name && message.status !== "starting") {
        const title = message.agentInfo?.title ?? message.agentTitle;
        const version = message.agentInfo?.version ? ` ${message.agentInfo.version}` : "";
        flashNotice(`${title}${version} is running — new session, ask it anything.`, "good");
        switching = null;
        closeAgentPicker();
      } else if (previous && previous.agentName !== message.agentName) {
        closeAgentPicker();
      }
      paintTopbar();
      break;
    }
    case "agent_status":
      status = message.status;
      statusDetail = message.detail ?? "";
      if (switching && (message.status === "error" || message.status === "exited")) {
        // A failed switch must not leave the picker claiming to be starting.
        showPickerState(message.detail || `${switching.title} failed to start.`, true);
        switching = null;
      }
      paintTopbar();
      break;
    case "acp":
      transcript.apply(message.payload.update);
      break;
    case "session_reset":
      resetForNewSession(message);
      closeAgentPicker();
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
