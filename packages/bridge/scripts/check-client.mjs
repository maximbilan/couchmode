#!/usr/bin/env node
/**
 * Checks that a stopped ACP client goes silent.
 *
 * Killing an agent makes its `exited` promise resolve a moment later. If the
 * stopped client is still wired to the hub it broadcasts `agent_status: exited`
 * - carrying the dead agent's stderr - after its replacement has already
 * reported ready, and switching agents looks like the new agent crashed.
 *
 * Run: node scripts/check-client.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CouchmodeAcpClient } from "../dist/acp/client.js";
import { createFakeAgent, loadFixture } from "../dist/fake.js";

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
let passed = 0;
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(name);
  console.log(`${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The fake agent paces its replay with unref'd timers, which is right inside the
// CLI where the HTTP server holds the loop open. Standing alone there is nothing
// else pending, so hold the loop open here instead.
const keepAlive = setInterval(() => {}, 1000);

const fixture = await loadFixture(join(bridgeRoot, "fixtures", "claude-readme-tests.jsonl"));
const agent = createFakeAgent(fixture);

const events = [];
const client = new CouchmodeAcpClient(
  agent,
  process.cwd(),
  {
    onSessionUpdate: () => events.push("update"),
    onStatus: (status) => events.push(`status:${status}`),
    onPermissionRequest: () => events.push("permission"),
    onPermissionResolved: () => events.push("resolved"),
  },
  "test",
  ["default"],
);

await client.start();
check(
  "the client reports ready after a handshake",
  events.includes("status:ready"),
  events.join(","),
);

events.length = 0;
await client.stop();
// The agent's exit resolves asynchronously, which is exactly the race.
await sleep(600);

check(
  "a stopped client emits no further status",
  !events.some((e) => e.startsWith("status:")),
  events.length ? events.join(",") : "(silent)",
);
check("a stopped client emits nothing at all", events.length === 0, events.join(",") || "(silent)");
check(
  "in particular it never reports exited after being stopped",
  !events.includes("status:exited"),
);

clearInterval(keepAlive);
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length > 0) for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
