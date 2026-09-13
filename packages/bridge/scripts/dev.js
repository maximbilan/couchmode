// Dev runner: compile the bridge in watch mode, start Vite for the web client,
// and run the CLI against the Vite dev server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(bridgeRoot, "..", "..");
const args = process.argv.slice(2);
const children = [];

function run(command, argv, options = {}) {
  const child = spawn(command, argv, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  return child;
}

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const WEB_DEV_PORT = 5273;

run(
  "pnpm",
  [
    "--filter",
    "@couchmode/web",
    "run",
    "dev",
    "--",
    "--port",
    String(WEB_DEV_PORT),
    "--strictPort",
  ],
  { cwd: repoRoot },
);

const tsc = run(
  "pnpm",
  ["exec", "tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"],
  { cwd: bridgeRoot },
);

// Wait for the first successful compile before starting the CLI.
const entry = join(bridgeRoot, "dist", "cli.js");
const waitForBuild = setInterval(() => {
  if (!existsSync(entry)) return;
  clearInterval(waitForBuild);
  run("node", ["scripts/copy-assets.js"], { cwd: bridgeRoot }).on("exit", () => {
    run("node", [entry, "--web-dev-url", `http://localhost:${WEB_DEV_PORT}`, ...args], {
      cwd: process.env.COUCHMODE_CWD ?? repoRoot,
    });
  });
}, 300);

tsc.on("exit", stop);
