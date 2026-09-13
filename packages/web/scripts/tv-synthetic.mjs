#!/usr/bin/env node
/**
 * Renders the synthetic fixture, which carries the session/update types the
 * real Claude recording happens not to contain: a plan block and a thought
 * chunk. Without this, plan and collapsed-thought rendering would ship untested.
 *
 * Run via scripts/tv-check.sh.
 */
import { connect, createChecks, evaluate, press, screenshot, sleep, type } from "./cdp.mjs";

setTimeout(() => {
  console.error("GLOBAL TIMEOUT");
  process.exit(2);
}, 90_000).unref();

const PORT = process.argv[2];
const CODE = process.argv[3];
const SHOT = process.argv[4] ?? "tv-synthetic.png";
const { check, finish } = createChecks();
const targets = await (await fetch("http://localhost:9222/json/list")).json();
const cdp = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});

await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/tv?code=${CODE}` });
await sleep(2200);

// Submit a prompt so the replay starts.
await press(cdp, "ArrowDown");
await press(cdp, "Enter");
await sleep(300);
await type(cdp, "summarize this project");
await press(cdp, "Enter");

// The synthetic fixture raises two permission requests; approve both so the
// replay runs to completion and the feed is reachable again.
let answered = 0;
for (let i = 0; i < 90; i += 1) {
  await sleep(400);
  const state = await evaluate(
    cdp,
    `(() => {
    const m = document.querySelector('#permission-modal');
    if (!m) return { modal: false };
    const f = document.querySelector('.focused');
    return { modal: true, resolved: !!m.querySelector('.resolved'), kind: f?.dataset?.kind ?? null };
  })()`,
  );
  if (state.modal && !state.resolved && state.kind) {
    // Walk left to the first option (allow) and take it.
    await press(cdp, "ArrowLeft");
    await press(cdp, "ArrowLeft");
    await press(cdp, "Enter");
    answered += 1;
    await sleep(1200);
  }
  if (!state.modal && answered >= 2) break;
}
check("approved both permission requests from the remote", answered >= 2, `${answered} answered`);

const feed = await evaluate(
  cdp,
  `(() => {
  const f = document.querySelector('#feed');
  const thought = f.querySelector('.thought .body');
  const plan = f.querySelector('.plan');
  return {
    thoughts: f.querySelectorAll('.thought').length,
    thoughtText: thought?.textContent?.trim().slice(0, 48),
    clamp: thought ? getComputedStyle(thought).webkitLineClamp : null,
    planEntries: plan ? plan.querySelectorAll('.entry').length : 0,
    planStatuses: plan ? [...plan.querySelectorAll('.entry')].map(e => e.dataset.status) : [],
    planMarks: plan ? [...plan.querySelectorAll('.mark')].map(e => e.textContent) : [],
  };
})()`,
);
check("thought chunk rendered", feed.thoughts > 0, feed.thoughtText);
check("thoughts are collapsed by default (line-clamp 2)", feed.clamp === "2");
check(
  "plan block rendered with entries",
  feed.planEntries > 0,
  `${feed.planEntries}: ${feed.planStatuses.join(",")}`,
);
check(
  "plan entries show status marks",
  feed.planMarks.some((m) => "▸✓○".includes(m)),
  feed.planMarks.join(" "),
);

// Walk focus back to the feed with real arrow keys and toggle thoughts.
for (let i = 0; i < 10; i += 1) {
  const id = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
  if (id === "feed") break;
  if (id === "cancel") await press(cdp, "ArrowLeft");
  else await press(cdp, "ArrowUp");
}
const onFeed = await evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);
check("arrow keys reach the feed", onFeed === "feed", onFeed ?? "none");

const collapsedH = await evaluate(
  cdp,
  `Math.round(document.querySelector('.thought .body').getBoundingClientRect().height)`,
);
await press(cdp, "Enter");
await sleep(250);
const openState = await evaluate(
  cdp,
  `(() => {
  const f = document.querySelector('#feed');
  return { open: f.classList.contains('thoughts-open'),
           h: Math.round(f.querySelector('.thought .body').getBoundingClientRect().height) };
})()`,
);
check(
  "Enter on the feed expands thoughts",
  openState.open === true && openState.h > collapsedH,
  `collapsed=${collapsedH}px open=${openState.h}px`,
);
await screenshot(cdp, SHOT);

const passed = finish();
cdp.close();
process.exit(passed ? 0 : 1);
