/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Uses Node 22's built-in WebSocket, so driving a real browser costs no
 * dependency. Only what the TV acceptance test needs: evaluate an expression,
 * dispatch a key, take a screenshot.
 */

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => ws.close() };
}

/**
 * Windows virtual key codes Chrome expects. A Fire TV remote's D-pad arrives in
 * the WebView as exactly these keys, which is what makes this a fair proxy for
 * the real device.
 */
const KEYS = {
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  Escape: 27,
  Backspace: 8,
};

export async function press(cdp, key) {
  const code = KEYS[key];
  if (!code) throw new Error(`unmapped key ${key}`);
  const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(90);
}

export async function type(cdp, text) {
  for (const character of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: character, key: character });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
  }
  await sleep(80);
}

export async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

export async function screenshot(cdp, path) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, Buffer.from(shot.data, "base64"));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared assertion tally so each test file reports the same way. */
export function createChecks() {
  const failures = [];
  let passed = 0;
  return {
    check(name, condition, detail = "") {
      if (condition) passed += 1;
      else failures.push(name + (detail ? ` :: ${detail}` : ""));
      console.log(`${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    },
    finish() {
      console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
      if (failures.length > 0) for (const failure of failures) console.log(`  ✗ ${failure}`);
      return failures.length === 0;
    },
  };
}
