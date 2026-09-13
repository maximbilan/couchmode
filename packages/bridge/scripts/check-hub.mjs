#!/usr/bin/env node
/**
 * Bridge hub checks: pairing, broadcast, replay and the `prompt_draft` relay.
 *
 * Spawns its own bridge in fake mode, so it needs nothing running. Uses Node's
 * built-in WebSocket - no dependency.
 *
 * Run: node scripts/check-hub.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.COUCHMODE_CHECK_PORT ?? 7911);
const CODE = "424242";

const failures = [];
let passed = 0;
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(name);
  console.log(`${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const bridge = spawn(
  process.execPath,
  [join(bridgeRoot, "dist", "cli.js"), "--fake", "--code", CODE, "--port", String(PORT)],
  { stdio: "ignore" },
);
process.on("exit", () => bridge.kill());

/** Connect and pair, resolving once the replay has been delivered. */
function open(clientType, code = CODE) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
    const received = [];
    const timer = setTimeout(() => reject(new Error(`${clientType} never paired`)), 8000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "pair", code, clientType })),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      received.push(message);
      if (message.type === "replay_end" || message.type === "error") {
        clearTimeout(timer);
        resolve({ socket, received });
      }
    });
    socket.addEventListener("error", reject);
  });
}

// Wait for the bridge to bind.
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`http://localhost:${PORT}/healthz`);
    if (res.ok) break;
  } catch {
    await sleep(250);
  }
}

const tv = await open("tv");
check(
  "pairing returns hello then replay_end",
  tv.received[0]?.type === "hello" && tv.received.at(-1)?.type === "replay_end",
  tv.received.map((m) => m.type).join(","),
);
// A client may pair before the ACP session exists, so the mode arrives in a
// follow-up hello once the agent is ready.
let mode = null;
for (let i = 0; i < 30; i += 1) {
  const latest = tv.received.filter((m) => m.type === "hello").at(-1);
  mode = latest?.mode?.currentModeId ?? null;
  if (mode) break;
  await sleep(250);
}
check("an early client is re-announced the session mode", mode === "default", mode ?? "none");

const wrong = await open("phone", "000000");
check(
  "a wrong pair code is rejected",
  wrong.received.some((m) => m.type === "error" && m.message === "wrong pair code"),
);
wrong.socket.close();

const phone = await open("phone");
await sleep(400);
const before = tv.received.length;
phone.socket.send(
  JSON.stringify({ type: "prompt_draft", text: "add a test for the minutes branch" }),
);
await sleep(500);

const relayed = tv.received.slice(before).filter((m) => m.type === "prompt_draft");
check("a draft reaches the other client", relayed.length === 1, JSON.stringify(relayed[0] ?? null));
check("the draft names its sender", relayed[0]?.from === "phone", relayed[0]?.from);
check(
  "the sender does not receive its own draft",
  phone.received.filter((m) => m.type === "prompt_draft").length === 0,
);

// Drafts are ephemeral and must never appear in a later client's replay.
const late = await open("tv");
check(
  "drafts are not replayed to new clients",
  late.received.filter((m) => m.type === "prompt_draft").length === 0,
);

for (const connection of [tv, phone, late]) connection.socket.close();
bridge.kill();

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length > 0) for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
