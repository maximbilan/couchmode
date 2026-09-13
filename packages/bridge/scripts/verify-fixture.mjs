#!/usr/bin/env node
/**
 * Prove a `--fake` replay reproduces the recording it came from.
 *
 * Compares the agent -> client message streams of two recordings, normalising
 * the parts that are legitimately allowed to differ between runs:
 *   - JSON-RPC ids (each connection numbers its own requests)
 *   - timestamps (replay applies its own pacing)
 *
 * Usage: node scripts/verify-fixture.mjs <original.jsonl> <replay.jsonl>
 */
import { readFileSync } from "node:fs";

function load(path) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines.slice(1).map((l) => JSON.parse(l));
}

/** Agent -> client traffic is what the UI actually sees. */
function normalise(entries) {
  return entries
    .filter((e) => e.dir === "agent")
    .map((e) => {
      const msg = { ...e.msg };
      if ("id" in msg) msg.id = "<id>";
      return JSON.stringify(msg);
    });
}

const [, , originalPath, replayPath] = process.argv;
if (!originalPath || !replayPath) {
  console.error("usage: verify-fixture.mjs <original.jsonl> <replay.jsonl>");
  process.exit(2);
}

const original = normalise(load(originalPath));
const replay = normalise(load(replayPath));

let mismatches = 0;
const max = Math.max(original.length, replay.length);
for (let i = 0; i < max; i += 1) {
  if (original[i] !== replay[i]) {
    mismatches += 1;
    if (mismatches <= 3) {
      console.error(`\n✗ message ${i} differs`);
      console.error(`  original: ${(original[i] ?? "<missing>").slice(0, 300)}`);
      console.error(`  replay:   ${(replay[i] ?? "<missing>").slice(0, 300)}`);
    }
  }
}

if (mismatches === 0) {
  console.log(`✓ replay is identical: ${original.length} agent messages matched`);
  process.exit(0);
}
console.error(`\n✗ ${mismatches}/${max} agent messages differ`);
process.exit(1);
