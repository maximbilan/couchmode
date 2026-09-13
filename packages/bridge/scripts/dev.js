// Dev runner: compile the bridge in watch mode, start Vite for the web client,
// and run the CLI against the Vite dev server.
//
// Args after `pnpm dev` are forwarded to the CLI, e.g. `pnpm dev -- --fake`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(bridgeRoot, "..", "..");
const webRoot = join(repoRoot, "packages", "web");

// pnpm forwards its own `--` separator through to the script, so drop any bare
// `--` tokens before handing the rest to the CLI.
const args = process.argv.slice(2).filter((arg) => arg !== "--");

const WEB_DEV_PORT = 5273;
const children = [];
let stopping = false;

function run(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: "inherit", ...options });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// Spawn the local binaries directly: going back through `pnpm run` here means
// argument forwarding depends on pnpm's own `--` handling.
const viteBin = join(webRoot, "node_modules", ".bin", "vite");
run(viteBin, ["--port", String(WEB_DEV_PORT), "--strictPort"], { cwd: webRoot });

const tscBin = join(bridgeRoot, "node_modules", ".bin", "tsc");
const tsc = run(tscBin, ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], {
  cwd: bridgeRoot,
});
tsc.on("exit", () => stop(1));

// Wait for the first successful compile before starting the CLI.
const entry = join(bridgeRoot, "dist", "cli.js");
const waitForBuild = setInterval(() => {
  if (!existsSync(entry)) return;
  clearInterval(waitForBuild);
  run(process.execPath, [join(bridgeRoot, "scripts", "copy-assets.js")], {
    cwd: bridgeRoot,
  }).on("exit", () => {
    const cli = run(
      process.execPath,
      [entry, "--web-dev-url", `http://localhost:${WEB_DEV_PORT}`, ...args],
      { cwd: process.env.COUCHMODE_CWD ?? repoRoot },
    );
    cli.on("exit", (code) => stop(code ?? 0));
  });
}, 300);
