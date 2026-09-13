#!/usr/bin/env node
/**
 * Phone acceptance test: pairing, the transcript mirror, permission options
 * and the agent picker.
 *
 * There is deliberately no in-page dictation. Phone keyboards have their own
 * microphone key, which works on any origin because it belongs to the OS - and
 * the Web Speech API never could, since the bridge serves plain HTTP over the
 * LAN and browsers only expose speech recognition in a secure context.
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

await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.clear();" });

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
  mic: !!document.querySelector('#mic'),
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
check("there is no in-page dictation button", main.mic === false);
check("no horizontal scroll at 390px wide", main.noHScroll === true);

await evaluate(cdp, `document.querySelector('#input').value = 'summarize this project'; 0`);
check(
  "text lands in the composer, unsent",
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
// loads a LAN IP over plain HTTP. There must be no dictation button on either.
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
    mic: !!document.querySelector('#mic'),
    micVisible: (() => {
      const m = document.querySelector('#mic');
      return m ? getComputedStyle(m).display !== 'none' : false;
    })(),
    placeholder: document.querySelector('#input')?.placeholder ?? null,
  })`,
  ).then(JSON.parse);

  check("a LAN origin is not a secure context", insecure.secure === false, `http://${lan}:${PORT}`);
  check(
    "the Speech API still exists there, which is why relying on it was a trap",
    insecure.speechApi === "function",
    insecure.speechApi,
  );
  check("no dictation button exists at a LAN origin", insecure.mic === false);
  check("nothing mic-shaped is rendered", insecure.micVisible === false);
  check(
    "the placeholder stays out of the way",
    !/dictate|keyboard/i.test(insecure.placeholder ?? ""),
    insecure.placeholder,
  );
}

const passed = finish();
cdp.close();
process.exit(passed ? 0 : 1);
