#!/usr/bin/env node
/**
 * Replays a recorded fixture through the transcript view-model and prints what
 * the UI would show. Catches ACP-shape regressions without needing a browser.
 *
 * The shared modules are plain TypeScript, so compile them to a temp directory
 * first with the package's own tsc, then import the JavaScript.
 *
 * Run: node scripts/check-render.mjs <fixture.jsonl>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const path = process.argv[2];
if (!path) {
  console.error("usage: check-render.mjs <fixture.jsonl>");
  process.exit(2);
}

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const out = mkdtempSync(join(tmpdir(), "couchmode-render-"));
let render;
try {
  execFileSync(
    join(packageRoot, "node_modules", ".bin", "tsc"),
    [
      join(packageRoot, "src", "shared", "render.ts"),
      "--outDir",
      out,
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--strict",
      "--skipLibCheck",
    ],
    { stdio: "inherit" },
  );
  render = await import(pathToFileURL(join(out, "render.js")).href);
} finally {
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
}

const { buildDiff, latestDiff, renderMarkdown, TranscriptModel } = render;

const entries = readFileSync(path, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .slice(1)
  .map((line) => JSON.parse(line));

const ignored = new Map();
const model = new TranscriptModel({
  onAdd: () => {},
  onUpdate: () => {},
  onIgnored: (type, reason) => ignored.set(type, reason),
});

let applied = 0;
for (const entry of entries) {
  const update = entry.msg?.params?.update;
  if (!update || entry.dir !== "agent") continue;
  if (model.apply(update)) applied += 1;
}

console.log(`applied ${applied} updates -> ${model.items.length} transcript items`);
const counts = {};
for (const item of model.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
console.log("items by kind:", JSON.stringify(counts));
console.log("ignored update types:", JSON.stringify([...ignored.keys()]));

for (const item of model.items) {
  if (item.kind === "message") {
    console.log(`\n[${item.role}] ${item.text.length} chars`);
    console.log(item.text.slice(0, 200).replace(/\n/g, "\\n"));
  } else if (item.kind === "tool_call") {
    console.log(
      `[tool ${item.call.toolKind}] ${item.call.title.slice(0, 64).replace(/\n/g, " ")} (${item.call.status})`,
    );
  } else if (item.kind === "plan") {
    console.log(`[plan] ${item.entries.length} entries`);
  } else if (item.kind === "thought") {
    console.log(`[thought] ${item.text.slice(0, 80)}`);
  }
}

const diff = latestDiff(model.items);
if (!diff) {
  console.error("\n✗ no diff found in fixture");
  process.exit(1);
}
const view = buildDiff(diff);
console.log(`\n--- latest diff: ${view.path}  +${view.added} -${view.removed} ---`);
for (const line of view.lines.slice(0, 20)) {
  const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  console.log(`${sign} ${line.text}`);
}

const agentText = model.items.find((i) => i.kind === "message" && i.role === "agent")?.text ?? "";
const markdown = renderMarkdown(agentText);
if (!markdown.includes("<strong>") && !markdown.includes("<p>")) {
  console.error("\n✗ markdown renderer produced nothing useful");
  process.exit(1);
}
console.log("\n✓ render pipeline ok");
