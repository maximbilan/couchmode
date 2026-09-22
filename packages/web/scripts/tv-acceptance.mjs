#!/usr/bin/env node
/**
 * TV acceptance test: drives /tv in headless Chrome at 1920x1080 using only the
 * keys a Fire TV remote has.
 *
 * This is the M2 acceptance criterion made executable - layout, spatial focus,
 * the permission modal and the diff panel, all against `--fake`.
 *
 * Run via scripts/tv-check.sh, which starts a fresh bridge and browser.
 */
import { connect, createChecks, evaluate, press, screenshot, sleep, type } from "./cdp.mjs";

setTimeout(() => {
  console.error("GLOBAL TIMEOUT");
  process.exit(2);
}, 120_000).unref();

const PORT = process.argv[2] ?? "7801";
const CODE = process.argv[3] ?? "123456";
const SHOT = process.argv[4] ?? "tv.png";
const { check, finish } = createChecks();

/**
 * The same suite runs against headless Chrome and against a real Fire TV.
 *
 * On a device, point COUCHMODE_CDP at the forwarded WebView devtools socket and
 * COUCHMODE_TV_URL at the bridge's LAN address; the device is already 1920x1080
 * so the viewport emulation is skipped.
 */
const CDP_ENDPOINT = process.env.COUCHMODE_CDP ?? "http://localhost:9222";
const TV_URL = process.env.COUCHMODE_TV_URL ?? `http://localhost:${PORT}/tv`;
const ON_DEVICE = process.env.COUCHMODE_CDP !== undefined;
// Describe what the remote is pointed at right now.
const FOCUS_EXPR = `(() => {
  const f = document.querySelector('.focused');
  if (!f) return null;
  return {
    cls: f.className,
    id: f.id || null,
    text: (f.textContent || '').trim().slice(0, 60),
    tag: f.tagName,
  };
})()`;

const targets = await (await fetch(`${CDP_ENDPOINT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" || t.url.includes("/tv"));
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

if (!ON_DEVICE) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

// The TV deliberately remembers its pair code, so start each run from a
// factory-fresh device or the digit presses below land on the wrong values.
await cdp.send("Page.navigate", { url: TV_URL });
await sleep(1200);
await evaluate(cdp, "localStorage.clear()");
await cdp.send("Page.navigate", { url: `${TV_URL}${TV_URL.includes("?") ? "&" : "?"}fresh=1` });
await sleep(ON_DEVICE ? 2500 : 1400);

// --- pairing: D-pad only -------------------------------------------------
const digits = CODE.split("").map(Number);
let pairingFocus = await evaluate(cdp, FOCUS_EXPR);
check(
  "pairing screen focuses the first digit",
  pairingFocus?.cls?.includes("digit") === true,
  pairingFocus?.text,
);

for (let i = 0; i < digits.length; i += 1) {
  for (let n = 0; n < digits[i]; n += 1) await press(cdp, "ArrowUp");
  if (i < digits.length - 1) await press(cdp, "ArrowRight");
}
const typedCode = await evaluate(
  cdp,
  `[...document.querySelectorAll('.digit .value')].map(e=>e.textContent).join('')`,
);
check("D-pad entered the pair code", typedCode === CODE, `got ${typedCode}`);

await press(cdp, "Enter");
await sleep(1800);

// --- main layout ---------------------------------------------------------
const layout = await evaluate(
  cdp,
  `(() => {
  const g = (s) => document.querySelector(s);
  const feed = g('#feed'), diff = g('#diff');
  const r = (e) => e ? e.getBoundingClientRect() : null;
  return {
    screen: !!g('.topbar'),
    project: g('#project')?.textContent,
    branch: g('#branch')?.textContent,
    agent: g('#agent')?.textContent,
    status: g('#status')?.textContent,
    link: g('#link')?.textContent,
    linkState: g('#link')?.dataset?.link ?? null,
    statusStale: g('#status')?.dataset?.stale ?? null,
    clients: g('#clients')?.textContent,
    feedW: r(feed)?.width, diffW: r(diff)?.width,
    diffPanelHidden: g('#diff-panel')?.hidden ?? null,
    vw: innerWidth, vh: innerHeight,
    bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    promptH: r(g('#prompt'))?.height,
    cancelH: r(g('#cancel'))?.height,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`,
);
check("main screen rendered", layout.screen === true);
check(
  "viewport is 1920x1080",
  layout.vw === 1920 && layout.vh === 1080,
  `${layout.vw}x${layout.vh}`,
);
check(
  "top bar shows project/branch/agent/status",
  !!layout.project && !!layout.branch && !!layout.agent && !!layout.status,
  `${layout.project} | ${layout.branch} | ${layout.agent} | ${layout.status}`,
);
check("clients indicator present", /📺|📱/.test(layout.clients ?? ""), layout.clients);
// The link is stated in words. From three metres a small green dot and a small
// grey one are the same dot, so "Connected" has to be readable text.
check(
  "the top bar says the bridge is connected",
  layout.linkState === "paired" && /connected/i.test(layout.link ?? ""),
  `${layout.link} (${layout.linkState})`,
);
check(
  "the agent status is not marked stale while connected",
  layout.statusStale === "false",
  layout.statusStale ?? "unset",
);
// Before any file changes there is nothing to put in the Changes panel, so it
// is not on screen at all and the feed has the width to itself.
check("the Changes panel is hidden until there is a diff", layout.diffPanelHidden === true);
check(
  "the feed spans the full width while Changes is hidden",
  layout.feedW > layout.vw * 0.9,
  `${Math.round(layout.feedW)}px of ${layout.vw}px`,
);
check("body text >= 28px", layout.bodyFont >= 28, `${layout.bodyFont}px`);
check("prompt bar >= 64px tall", layout.promptH >= 64, `${Math.round(layout.promptH)}px`);
check("stop button >= 64px tall", layout.cancelH >= 64, `${Math.round(layout.cancelH)}px`);
check("no horizontal page scroll", layout.hScroll === false);

// --- focus manager: spatial navigation -----------------------------------
let f = await evaluate(cdp, FOCUS_EXPR);
check("focus starts on the activity feed", f?.id === "feed", f?.id ?? "none");

await press(cdp, "ArrowRight");
f = await evaluate(cdp, FOCUS_EXPR);
check("right does not reach a hidden Changes panel", f?.id === "feed", f?.id ?? "none");

await press(cdp, "ArrowDown");
f = await evaluate(cdp, FOCUS_EXPR);
check("down from feed reaches the prompt bar", f?.id === "prompt", f?.id ?? "none");

await press(cdp, "ArrowRight");
f = await evaluate(cdp, FOCUS_EXPR);
check("right reaches the Stop button", f?.id === "cancel", f?.id ?? "none");

await press(cdp, "ArrowLeft");
await press(cdp, "ArrowUp");
f = await evaluate(cdp, FOCUS_EXPR);
check("up returns to the feed", f?.id === "feed", f?.id ?? "none");

// --- agent picker --------------------------------------------------------
// Reachable from the top bar rather than only behind a hidden key, so the
// remote can find it.
// The feed is a scroller: ArrowUp pans it and only releases focus once it
// reaches the top, so this may take several presses on a long transcript.
await evaluate(cdp, `document.querySelector('#feed').scrollTop = 0`);
await sleep(300);
let agentFocus = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
for (let i = 0; i < 20 && agentFocus !== "agent"; i += 1) {
  await press(cdp, "ArrowUp");
  await sleep(150);
  agentFocus = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
}
check("the agent name in the top bar is focusable", agentFocus === "agent", agentFocus ?? "none");

await press(cdp, "Enter");
await sleep(400);
const picker = await evaluate(
  cdp,
  `(() => {
  const p = document.querySelector('#agent-picker');
  if (!p) return null;
  return {
    options: [...p.querySelectorAll('.agent-option')].map((b) => b.textContent.trim()),
    commands: [...p.querySelectorAll('.agent-option .agent-command')].map((e) => e.textContent.trim()),
    active: [...p.querySelectorAll('.agent-option')].filter((b) => b.dataset.active === 'true').length,
    focused: document.querySelector('.focused')?.textContent?.trim() ?? null,
    warns: /new session/i.test(p.querySelector('.picker-note')?.textContent ?? ''),
  };
})()`,
);
check(
  "the picker opens and lists every configured agent",
  (picker?.options.length ?? 0) >= 4,
  picker?.options.join(", "),
);
check(
  "the running agent is marked and focused",
  picker?.active === 1 && /restart/.test(picker?.focused ?? ""),
  picker?.focused,
);
check("the picker warns that switching starts a new session", picker?.warns === true);
// Four rows that all say "CLI" are not a choice; the command is what differs.
check(
  "each agent row names the command it would run",
  (picker?.commands.length ?? 0) === (picker?.options.length ?? 0) &&
    picker?.commands.every((c) => c.length > 0) === true,
  picker?.commands.join(" | "),
);

await press(cdp, "Escape");
await sleep(300);
check(
  "Back closes the picker",
  (await evaluate(cdp, `!document.querySelector('#agent-picker')`)) === true,
);

// --- composer ------------------------------------------------------------
// Navigate to the prompt bar rather than assuming where the last section left
// focus, so reordering checks cannot silently break this one.
let onPrompt = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
for (let i = 0; i < 8 && onPrompt !== "prompt"; i += 1) {
  await press(cdp, onPrompt === "cancel" ? "ArrowLeft" : "ArrowDown");
  await sleep(120);
  onPrompt = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
}
check("arrow keys reach the prompt bar", onPrompt === "prompt", onPrompt ?? "none");
await press(cdp, "Enter");
await sleep(350);
const composerOpen = await evaluate(cdp, `!!document.querySelector('#prompt-input')`);
check("Enter on the prompt bar opens a text input", composerOpen === true);

await type(cdp, "list the files in this project and summarize it");
const draft = await evaluate(cdp, `document.querySelector('#prompt-input')?.value`);
check("typing reaches the input", draft?.startsWith("list the files"), draft);

await press(cdp, "Enter");
await sleep(600);
const closed = await evaluate(cdp, `!document.querySelector('#prompt-input')`);
check("Enter submits and closes the composer", closed === true);

console.log("\n--- waiting for the replay to reach a permission request ---");
let modal = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  modal = await evaluate(
    cdp,
    `(() => {
    const m = document.querySelector('#permission-modal');
    if (!m) return null;
    const focused = document.querySelector('.focused');
    return {
      summary: m.querySelector('.summary')?.textContent?.trim(),
      detail: (m.querySelector('.detail')?.textContent ?? '').slice(0, 60),
      options: [...m.querySelectorAll('.option')].map(b => ({ name: b.textContent, kind: b.dataset.kind })),
      focusedText: focused?.textContent?.trim(),
      focusedKind: focused?.dataset?.kind ?? null,
      summarySize: parseFloat(getComputedStyle(m.querySelector('.summary')).fontSize),
      optionH: m.querySelector('.option')?.getBoundingClientRect().height,
    };
  })()`,
  );
  if (modal) break;
}

check("permission modal appeared", !!modal, modal?.summary);
if (modal) {
  await screenshot(cdp, SHOT.replace(/\.png$/, "-modal.png"));
  check("modal summary is large (>=36px)", modal.summarySize >= 36, `${modal.summarySize}px`);
  check("option buttons >= 64px tall", modal.optionH >= 64, `${Math.round(modal.optionH)}px`);
  check(
    "modal renders the agent's own options in order",
    modal.options.length >= 2 && modal.options.every((o) => o.kind),
    modal.options.map((o) => `${o.name}/${o.kind}`).join(", "),
  );

  // An edit is "modifying": the diff is already on screen, so it starts on allow.
  check(
    "edit tool defaults to an allow option",
    modal.focusedKind?.startsWith("allow") === true,
    `tool="${modal.summary}" focused="${modal.focusedText}" kind=${modal.focusedKind}`,
  );

  // Feed underneath must be unreachable while the modal is up.
  await press(cdp, "ArrowUp");
  const stillInModal = await evaluate(
    cdp,
    `(() => {
    const f = document.querySelector('.focused');
    return !!f && !!f.closest('#permission-modal');
  })()`,
  );
  check("modal steals focus (feed unreachable)", stillInModal === true);

  // Exactly one ring, and it is inside the modal. Two rings, or a ring left
  // behind on the prompt bar, is unreadable from a sofa: it says the remote is
  // pointed somewhere it is not.
  const rings = await evaluate(
    cdp,
    `JSON.stringify((() => {
    const all = [...document.querySelectorAll('.focused')];
    return { count: all.length, inModal: all.every((e) => !!e.closest('#permission-modal')) };
  })())`,
  ).then(JSON.parse);
  check(
    "exactly one focus ring, inside the modal",
    rings.count === 1 && rings.inModal === true,
    `${rings.count} ring(s), inModal=${rings.inModal}`,
  );

  // That ArrowUp left focus on the scrollable detail box. Horizontal moves stay
  // within a row, so Down is the way back to the buttons.
  await press(cdp, "ArrowDown");
  const backOnOptions = await evaluate(
    cdp,
    `document.querySelector('.focused')?.dataset?.kind ?? null`,
  );
  check(
    "down returns from the detail box to the options",
    !!backOnOptions,
    backOnOptions ?? "none",
  );

  // Walk right across the option row to the reject button.
  await press(cdp, "ArrowRight");
  await press(cdp, "ArrowRight");
  const nowFocused = await evaluate(cdp, `document.querySelector('.focused')?.dataset?.kind`);
  check("arrows move between options", nowFocused?.startsWith("reject") === true, nowFocused);
  await press(cdp, "ArrowLeft");
  await press(cdp, "ArrowLeft");

  await press(cdp, "Enter");
  await sleep(400);
  const resolved = await evaluate(
    cdp,
    `document.querySelector('#permission-modal .resolved')?.textContent?.trim()`,
  );
  check("answering shows who resolved it", !!resolved, resolved);
  await sleep(1500);
  const after = await evaluate(
    cdp,
    `(() => {
    const m = document.querySelector('#permission-modal');
    return { present: !!m, summary: m?.querySelector('.summary')?.textContent?.trim() ?? null };
  })()`,
  );
  // Either the modal is gone, or the next queued request has taken its place.
  check(
    "resolved modal is dismissed",
    after.present === false || after.summary !== modal.summary,
    after.present ? `replaced by "${after.summary}"` : "closed",
  );
}

// --- second permission: Back = deny --------------------------------------
console.log("\n--- waiting for the second permission request ---");
let modal2 = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  modal2 = await evaluate(
    cdp,
    `(() => {
    const m = document.querySelector('#permission-modal');
    if (!m) return null;
    return { summary: m.querySelector('.summary')?.textContent?.trim(),
             focusedKind: document.querySelector('.focused')?.dataset?.kind ?? null };
  })()`,
  );
  if (modal2) break;
}
check("second permission modal appeared", !!modal2, modal2?.summary);
if (modal2) {
  check(
    "execute tool defaults to deny",
    modal2.focusedKind?.startsWith("reject") === true,
    modal2.focusedKind,
  );
  await press(cdp, "Escape");
  await sleep(400);
  const resolved2 = await evaluate(
    cdp,
    `document.querySelector('#permission-modal .resolved')?.textContent?.trim()`,
  );
  check("Back answers with the deny option", !!resolved2 && /reject/i.test(resolved2), resolved2);
  await sleep(1400);
}

// --- diff panel ----------------------------------------------------------
// The panel only exists once a file has changed, so focus should be able to
// reach it now when it could not at the start of the run.
await evaluate(cdp, `document.querySelector('#feed').scrollTop = 0`);
let atFeed = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
for (let i = 0; i < 8 && atFeed !== "feed"; i += 1) {
  await press(cdp, atFeed === "cancel" ? "ArrowLeft" : "ArrowUp");
  await sleep(120);
  atFeed = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
}
await press(cdp, "ArrowRight");
const reachable = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);

const diff = await evaluate(
  cdp,
  `(() => {
  const head = document.querySelector('#diff-head');
  const body = document.querySelector('#diff');
  const feed = document.querySelector('#feed');
  return {
    panelVisible: document.querySelector('#diff-panel')?.hidden === false,
    feedW: feed.getBoundingClientRect().width,
    diffW: body.getBoundingClientRect().width,
    path: head?.querySelector('.path')?.textContent,
    plus: head?.querySelector('.plus')?.textContent,
    minus: head?.querySelector('.minus')?.textContent,
    adds: body.querySelectorAll('.line.add').length,
    removes: body.querySelectorAll('.line.remove').length,
    scrollable: body.scrollHeight > body.clientHeight,
  };
})()`,
);
diff.reachable = reachable;
check("the Changes panel appears once a file changes", diff.panelVisible === true);
check(
  "it takes ~40% once shown",
  Math.abs(diff.diffW / (diff.feedW + diff.diffW) - 0.4) < 0.05,
  `${Math.round(diff.feedW)} / ${Math.round(diff.diffW)}`,
);
check("right now reaches the diff panel", diff.reachable === "diff", diff.reachable ?? "none");
check("diff panel shows a path", !!diff.path, diff.path);
check("diff header shows +N −M", !!diff.plus && !!diff.minus, `${diff.plus} ${diff.minus}`);
check(
  "diff body has coloured add lines",
  diff.adds > 0,
  `${diff.adds} add / ${diff.removes} remove`,
);

// --- feed content --------------------------------------------------------
const feed = await evaluate(
  cdp,
  `(() => {
  const f = document.querySelector('#feed');
  return {
    msgs: f.querySelectorAll('.msg').length,
    tools: f.querySelectorAll('.tool').length,
    thoughts: f.querySelectorAll('.thought').length,
    toolTitles: [...f.querySelectorAll('.tool .title')].slice(0,3).map(e=>e.textContent),
    statusPill: document.querySelector('#status')?.textContent,
    clamped: (() => { const t = f.querySelector('.thought .body');
      return t ? getComputedStyle(t).webkitLineClamp === '2' : 'n/a'; })(),
  };
})()`,
);
check("feed rendered agent messages", feed.msgs > 0, `${feed.msgs} messages`);
check(
  "feed rendered tool call rows",
  feed.tools > 0,
  `${feed.tools} tools: ${feed.toolTitles.join(" | ")}`,
);

// --- escaping a long transcript ------------------------------------------
// The reported problem: scroll up to read something in a long conversation and
// the remote is stranded. The feed is a scroller, so it eats every down press
// until it reaches the bottom - and while the agent is streaming, the bottom
// keeps moving away. Reaching the prompt bar has to be bounded, not linear in
// the length of the conversation.
await press(cdp, "ArrowLeft"); // off the diff panel, back onto the feed
await sleep(250);

const beforeScroll = await evaluate(
  cdp,
  `JSON.stringify((() => {
  const f = document.querySelector('#feed');
  const chip = document.querySelector('#feed-jump');
  return {
    focused: document.querySelector('.focused')?.id ?? null,
    top: f.scrollTop,
    page: f.clientHeight,
    max: f.scrollHeight - f.clientHeight,
    chipShown: chip ? !chip.hidden : null,
  };
})())`,
).then(JSON.parse);
check("the remote is on the feed", beforeScroll.focused === "feed", beforeScroll.focused ?? "none");
check(
  "the feed is long enough to strand the remote",
  beforeScroll.max > 40,
  `${Math.round(beforeScroll.max)}px of scroll below the fold`,
);

// One press of up must cover most of a screen, not a fixed sliver: this is the
// difference between a handful of presses and dozens.
await press(cdp, "ArrowUp");
await sleep(700);
const scrolledUp = await evaluate(
  cdp,
  `JSON.stringify((() => {
  const f = document.querySelector('#feed');
  const chip = document.querySelector('#feed-jump');
  return {
    top: f.scrollTop,
    chipShown: chip ? !chip.hidden : false,
    chipText: chip?.textContent?.trim() ?? null,
  };
})())`,
).then(JSON.parse);
const moved = beforeScroll.top - scrolledUp.top;
check(
  "one press scrolls most of a page",
  moved >= Math.min(beforeScroll.max, beforeScroll.page * 0.7),
  `moved ${Math.round(moved)}px of a ${Math.round(beforeScroll.page)}px page`,
);
check(
  "scrolling up says the screen is no longer live",
  scrolledUp.chipShown === true && /back/i.test(scrolledUp.chipText ?? ""),
  scrolledUp.chipShown ? scrolledUp.chipText : "chip hidden",
);

// Back is the unconditional escape hatch: one press returns to the present,
// however far up the transcript the remote has wandered.
await press(cdp, "Escape");
await sleep(400);
const jumped = await evaluate(
  cdp,
  `JSON.stringify((() => {
  const f = document.querySelector('#feed');
  const chip = document.querySelector('#feed-jump');
  return {
    atBottom: f.scrollHeight - f.scrollTop - f.clientHeight < 60,
    chipShown: chip ? !chip.hidden : false,
    focused: document.querySelector('.focused')?.id ?? null,
  };
})())`,
).then(JSON.parse);
check("Back jumps to the latest activity", jumped.atBottom === true && jumped.chipShown === false);
check("Back leaves the remote on the feed", jumped.focused === "feed", jumped.focused ?? "none");

// ...and from there the controls are one press away, however long the
// conversation is. Two presses total, from anywhere.
await press(cdp, "ArrowDown");
await sleep(250);
const escaped = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
check("the prompt bar is one press further down", escaped === "prompt", escaped ?? "none");

// --- screenshot ----------------------------------------------------------
// --- a session reset must not leave an overlay holding focus --------------
// The reported bug: switch agents while a permission modal is up and the modal
// stays on screen holding a focus layer and its requestId, so the remote is
// stuck behind a dialog describing a session that has ended.
await sleep(500);
const beforeReset = await evaluate(
  cdp,
  `JSON.stringify({
  items: document.querySelectorAll('#feed .msg, #feed .tool').length,
})`,
).then(JSON.parse);
check("the feed has content before the reset", beforeReset.items > 0, `${beforeReset.items} items`);

// Force a modal to be open at the moment the session ends.
await evaluate(
  cdp,
  `(() => {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'permission-modal';
  scrim.innerHTML = '<div class="modal"><div class="summary">stale</div></div>';
  document.querySelector('#app').append(scrim);
})()`,
);

// Selecting the running agent restarts it, which is a real session reset.
// Reach the picker with the remote and choose the running agent.
await evaluate(cdp, `document.querySelector('#feed').scrollTop = 0`);
let pickFocus = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
for (let i = 0; i < 20 && pickFocus !== "agent"; i += 1) {
  await press(cdp, "ArrowUp");
  await sleep(120);
  pickFocus = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
}
await press(cdp, "Enter");
await sleep(400);
await press(cdp, "Enter");

// Wait for the bridge to tear the session down and come back.
let reset = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  reset = await evaluate(
    cdp,
    `JSON.stringify({
    modal: !!document.querySelector('#permission-modal'),
    picker: !!document.querySelector('#agent-picker'),
    items: document.querySelectorAll('#feed .msg, #feed .tool').length,
    mark: document.querySelector('#feed .session-mark .title')?.textContent?.trim() ?? null,
    focused: document.querySelector('.focused')?.id ?? null,
    status: document.querySelector('#status')?.textContent,
  })`,
  ).then(JSON.parse);
  if (!reset.modal && reset.items === 0) break;
}
check("a session reset removes a stale permission modal", reset?.modal === false);
check("a session reset closes the agent picker", reset?.picker === false);
check("a session reset clears the transcript", reset?.items === 0, `${reset?.items} items left`);
// An emptied screen on its own reads as a crash. The marker says which agent
// the new session belongs to and that the old one ended on purpose.
check(
  "the new session is announced in the feed",
  /restart|new session/i.test(reset?.mark ?? ""),
  reset?.mark ?? "no marker",
);
check(
  "focus returns to a real control after the reset",
  !!reset?.focused,
  reset?.focused ?? "nothing focused",
);

// And the UI must still work afterwards.
await press(cdp, "ArrowDown");
const afterReset = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
check(
  "the remote still moves focus after a reset",
  !!afterReset && afterReset !== reset?.focused,
  afterReset ?? "none",
);

await screenshot(cdp, SHOT);
console.log(`\nscreenshot -> ${SHOT}`);

const passed = finish();
cdp.close();
process.exit(passed ? 0 : 1);
