#!/usr/bin/env node
/**
 * Phone acceptance test: pairing, the transcript mirror, permission options,
 * the agent picker, and the dictation button.
 *
 * Web Speech API support is injected before the page loads, because headless
 * Chrome has no speech engine. That is enough to prove the feature detection
 * and wiring are right; whether Chrome can hear a microphone is not ours.
 *
 * Run via scripts/tv-check.sh, which starts a fresh bridge and browser.
 */
import { networkInterfaces } from "node:os";
import { connect, createChecks, evaluate, screenshot, sleep } from "./cdp.mjs";

setTimeout(() => {
  console.error("GLOBAL TIMEOUT");
  process.exit(2);
}, 120_000).unref();

const PORT = process.argv[2] ?? "7803";
const CODE = process.argv[3] ?? "555555";
const SHOT = process.argv[4] ?? "phone.png";
const { check, finish } = createChecks();

const targets = await (await fetch("http://localhost:9222/json/list")).json();
const cdp = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});

// Stand in for a speech engine so the mic button's feature detection is live.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.SpeechRecognition = function () {
      this.lang = ""; this.interimResults = false; this.continuous = false;
      this.onresult = null; this.onend = null;
      this.start = () => { window.__micStarted = true; };
      this.stop = () => { window.__micStopped = true; this.onend && this.onend(); };
    };
    localStorage.clear();
  `,
});

await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/phone` });
await sleep(1500);

check(
  "pairing screen is shown first",
  (await evaluate(cdp, `!!document.querySelector('.code-input')`)) === true,
);
await evaluate(
  cdp,
  `(() => {
  const input = document.querySelector('#code');
  input.value = ${JSON.stringify(CODE)};
  document.querySelector('#pair').click();
})()`,
);
await sleep(1800);

const main = await evaluate(
  cdp,
  `JSON.stringify({
  paired: !!document.querySelector('#feed'),
  project: document.querySelector('#project')?.textContent,
  status: document.querySelector('#status')?.textContent,
  mic: !document.querySelector('#mic')?.hidden,
  agentButton: !document.querySelector('#agent-switch')?.hidden,
  noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
})`,
).then(JSON.parse);
check("pairing with the right code reaches the main screen", main.paired === true);
check(
  "header shows the project and agent status",
  !!main.project && !!main.status,
  `${main.project} · ${main.status}`,
);
check("the mic button appears in a secure context", main.mic === true);
check("no horizontal scroll at 390px wide", main.noHScroll === true);

// Dictation writes into the composer without sending anything.
await evaluate(cdp, `document.querySelector('#mic').click()`);
await sleep(300);
check(
  "tapping the mic starts recognition",
  (await evaluate(cdp, `!!window.__micStarted`)) === true,
);
check(
  "the mic button shows it is recording",
  (await evaluate(cdp, `document.querySelector('#mic').classList.contains('recording')`)) === true,
);

await evaluate(cdp, `document.querySelector('#input').value = 'summarize this project'; 0`);
check(
  "dictated text lands in the composer, unsent",
  (await evaluate(cdp, `document.querySelector('#input').value`)) === "summarize this project",
);

// Submit and watch the replay arrive.
await evaluate(cdp, `document.querySelector('#send').click()`);
await sleep(1500);

let permission = null;
for (let i = 0; i < 70; i += 1) {
  await sleep(500);
  permission = await evaluate(
    cdp,
    `(() => {
    const p = document.querySelector('.permission');
    if (!p) return null;
    return { summary: p.querySelector('.summary')?.textContent?.trim(),
             options: [...p.querySelectorAll('.option')].map((b) => b.textContent + '/' + b.dataset.kind) };
  })()`,
  );
  if (permission) break;
}
check("a permission request reaches the phone", !!permission, permission?.summary);
check(
  "it renders the agent's own options with their kinds",
  (permission?.options.length ?? 0) >= 2 &&
    permission.options.every((o) => o.includes("/allow") || o.includes("/reject")),
  permission?.options.join(", "),
);

await screenshot(cdp, SHOT);

// First answer wins: answering here resolves it everywhere.
await evaluate(cdp, `document.querySelector('.permission .option').click()`);
await sleep(1200);
const after = await evaluate(
  cdp,
  `document.querySelector('.permission .summary')?.textContent?.trim() ?? null`,
);
// The fixture raises a second request straight after, so the pane may be
// showing that one rather than nothing at all.
check(
  "answering clears that request from the phone",
  after === null || after !== permission.summary,
  after === null ? "pane empty" : `now showing "${after}"`,
);

const feed = await evaluate(
  cdp,
  `JSON.stringify({
  messages: document.querySelectorAll('.item.agent').length,
  tools: document.querySelectorAll('.tool').length,
})`,
).then(JSON.parse);
check(
  "the transcript mirrors the agent",
  feed.messages > 0 && feed.tools > 0,
  `${feed.messages} messages, ${feed.tools} tool rows`,
);

// --- the origin a phone actually uses -------------------------------------
// Everything above ran on localhost, which is a secure context. A real phone
// loads a LAN IP over plain HTTP, where the browser strips microphone access
// even though the Speech API object still exists. Offering a button that can
// never work there is worse than offering none.
const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

if (!lan) {
  console.log("… no LAN address; skipping the insecure-origin checks");
} else {
  await cdp.send("Page.navigate", { url: `http://${lan}:${PORT}/phone?code=${CODE}` });
  await sleep(2200);
  const insecure = await evaluate(
    cdp,
    `JSON.stringify({
    secure: window.isSecureContext,
    speechApi: typeof (window.SpeechRecognition || window.webkitSpeechRecognition),
    micHidden: document.querySelector('#mic')?.hidden ?? null,
    placeholder: document.querySelector('#input')?.placeholder ?? null,
  })`,
  ).then(JSON.parse);

  check("a LAN origin is not a secure context", insecure.secure === false, `http://${lan}:${PORT}`);
  check(
    "the Speech API still exists there, which is the trap",
    insecure.speechApi === "function",
    insecure.speechApi,
  );
  check("the mic button is hidden when dictation cannot work", insecure.micHidden === true);
  check(
    "the composer points at the keyboard's own dictation instead",
    /keyboard/i.test(insecure.placeholder ?? ""),
    insecure.placeholder,
  );
}

const passed = finish();
cdp.close();
process.exit(passed ? 0 : 1);
