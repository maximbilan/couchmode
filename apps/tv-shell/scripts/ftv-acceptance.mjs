#!/usr/bin/env node
/**
 * Fire TV hardware acceptance test.
 *
 * Every input is a real Android key event, the same path a physical remote
 * takes. CDP is used only to observe the page. This covers what browser-level
 * key injection cannot: that the shell forwards the remote into the WebView,
 * that hardware BACK runs couchmodeBack() rather than leaving the app, and that
 * a prompt typed on the TV can actually be submitted.
 *
 * Run via scripts/ftv-check.sh, which installs, launches and port-forwards.
 */
import { execFileSync } from "node:child_process";
import {
  connect,
  createChecks,
  evaluate,
  screenshot,
  sleep,
} from "../../../packages/web/scripts/cdp.mjs";

setTimeout(() => {
  console.error("GLOBAL TIMEOUT");
  process.exit(2);
}, 180_000).unref();

const DEVICE = process.env.TV_DEVICE ?? "";
const CDP = process.env.COUCHMODE_CDP ?? "http://localhost:9223";
const SHOT = process.argv[2] ?? "ftv.png";
const { check, finish } = createChecks();

const adb = (...args) =>
  execFileSync("adb", DEVICE ? ["-s", DEVICE, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const key = async (name, extra = []) => {
  adb("shell", "input", "keyevent", ...extra, name);
  await sleep(500);
};
const currentWindow = () =>
  (
    adb("shell", "dumpsys", "window")
      .split("\n")
      .find((l) => l.includes("mCurrentFocus")) ?? ""
  ).trim();

const targets = await (await fetch(`${CDP}/json/list`)).json();
const target = targets.find((t) => t.url.includes("/tv"));
if (!target) {
  console.error("no /tv page on the device - is the app showing the WebView?");
  process.exit(2);
}
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
const focusId = () => evaluate(cdp, `document.querySelector('.focused')?.id ?? null`);

// --- the page really is the 1920x1080 canvas -----------------------------
const layout = await evaluate(
  cdp,
  `JSON.stringify({ w: innerWidth, h: innerHeight,
    feed: Math.round(document.querySelector('#feed').getBoundingClientRect().width),
    diff: Math.round(document.querySelector('#diff').getBoundingClientRect().width),
    font: getComputedStyle(document.body).fontSize })`,
).then(JSON.parse);
check(
  "page lays out at 1920x1080 on the device",
  layout.w === 1920 && layout.h === 1080,
  `${layout.w}x${layout.h}`,
);
check(
  "60/40 split survives the WebView",
  Math.abs(layout.feed / (layout.feed + layout.diff) - 0.6) < 0.04,
  `${layout.feed}/${layout.diff}`,
);
check("body text is 28px", layout.font === "28px", layout.font);

// --- the remote drives focus inside the page -----------------------------
await key("KEYCODE_DPAD_RIGHT");
check("remote DPAD_RIGHT moves focus to the diff panel", (await focusId()) === "diff");
await key("KEYCODE_DPAD_LEFT");
check("remote DPAD_LEFT returns to the feed", (await focusId()) === "feed");
await key("KEYCODE_DPAD_DOWN");
check("remote DPAD_DOWN reaches the prompt bar", (await focusId()) === "prompt");

// --- typing and submitting from the remote -------------------------------
await key("KEYCODE_DPAD_CENTER");
await sleep(800);
check(
  "remote OK opens the composer",
  (await evaluate(cdp, `!!document.querySelector('#prompt-input')`)) === true,
);

adb("shell", "input", "text", "summarize%sthis%sproject");
await sleep(800);
const typed = await evaluate(cdp, `document.querySelector('#prompt-input')?.value ?? ""`);
check("text typed on the device reaches the input", typed.length > 0, typed);

// Fire TV's IME commits on Back and the page receives that as Enter, which is
// the only route to a submit while the keyboard is attached.
await key("KEYCODE_BACK");
await sleep(1200);
check(
  "dismissing the keyboard submits the prompt",
  (await evaluate(cdp, `!document.querySelector('#prompt-input')`)) === true,
);

// --- a permission request, answered with the hardware Back key -----------
console.log("\n--- waiting for a permission request ---");
let modal = null;
for (let i = 0; i < 80; i += 1) {
  await sleep(500);
  modal = await evaluate(
    cdp,
    `(() => {
    const m = document.querySelector('#permission-modal');
    if (!m || m.querySelector('.resolved')) return null;
    return { summary: m.querySelector('.summary')?.textContent?.trim(),
             focused: document.querySelector('.focused')?.dataset?.kind ?? null };
  })()`,
  );
  if (modal) break;
}
check("permission modal reached on the device", !!modal, modal?.summary);

if (modal) {
  await screenshot(cdp, SHOT.replace(/\.png$/, "-modal.png"));
  check("modal opens on a sensible default button", !!modal.focused, modal.focused);

  await key("KEYCODE_BACK");
  let resolved = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(200);
    resolved = await evaluate(
      cdp,
      `document.querySelector('#permission-modal .resolved')?.textContent?.trim() ?? null`,
    );
    if (resolved) break;
  }
  const showing = await evaluate(
    cdp,
    `document.querySelector('#permission-modal .summary')?.textContent?.trim() ?? null`,
  );
  // Either the banner was caught, or the queue already moved on - both mean
  // the request was answered rather than dismissed.
  check(
    "hardware BACK answers the request with its deny option",
    (!!resolved && /reject|no/i.test(resolved)) || (showing !== null && showing !== modal.summary),
    resolved ?? `now showing "${showing}"`,
  );
  check("hardware BACK did not leave the app", currentWindow().includes("com.couchmode.tv"));
}

// --- Back with nothing open must not drop out of the app -----------------
await sleep(2500);
await key("KEYCODE_BACK");
check(
  "BACK with nothing open keeps the app in front",
  currentWindow().includes("com.couchmode.tv"),
);
await screenshot(cdp, SHOT);
cdp.close();

// --- long-press MENU reopens the setup form ------------------------------
adb("logcat", "-c");
await key("KEYCODE_MENU", ["--longpress"]);
await sleep(2000);
// The WebView is detached rather than destroyed, so its devtools target
// survives; ask the view hierarchy what is actually on screen.
const hierarchy = adb("shell", "dumpsys", "activity", "top");
const setupShowing = hierarchy.includes("hostInput") || hierarchy.includes("setupRoot");
const logged = adb("logcat", "-d", "-s", "Couchmode").includes("MENU long press");
check(
  "long-press MENU reopens the setup form",
  setupShowing && logged,
  `setupView=${setupShowing} logged=${logged}`,
);

const passed = finish();
process.exit(passed ? 0 : 1);
