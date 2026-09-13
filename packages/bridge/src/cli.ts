#!/usr/bin/env node
/**
 * couchmode - runs in your project directory, spawns an ACP agent, and serves
 * the TV and phone clients over the LAN.
 */
import { randomInt } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadAgents, USER_AGENTS_PATH } from "./config/agents.js";
import type { AgentDefinition } from "./config/agents.js";
import { spawnAgent } from "./acp/agent-process.js";
import { CouchmodeAcpClient, errorText } from "./acp/client.js";
import type { AgentLike } from "./acp/client.js";
import { createFakeAgent, loadFixture } from "./fake.js";
import { createRecorder, teeStream } from "./record.js";
import { createHttpServer } from "./http.js";
import { Hub } from "./hub.js";
import type { ConnectedClient, ServerMessage } from "./protocol.js";
import { banner, info, log, warn } from "./log.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

interface Options {
  agent: string;
  port: number;
  host: string;
  code: string | null;
  cwd: string;
  webDevUrl: string | null;
  fake: string | boolean;
  record: string | null;
  mode: string | null;
}

const USAGE = `
couchmode - the ACP client for the couch

Usage
  couchmode [options]

Options
  --agent <name>     agent from agents.json to spawn          (default: claude)
  --port <number>    HTTP + WebSocket port                    (default: 7777)
  --host <addr>      interface to bind                        (default: 0.0.0.0)
  --code <digits>    fixed pair code, for development         (default: random 6 digits)
  --cwd <path>       project directory for the ACP session    (default: current directory)
  --mode <id>        ACP session mode to request                (default: from agents.json)
  --web-dev-url <u>  proxy the web client to a Vite dev server
  --fake [file]      replay a recorded session instead of spawning an agent
  --record <file>    record this session to a .jsonl fixture
  --help             show this message

Couchmode does not handle credentials. It runs your agent's CLI, which uses the
login you already have. If a CLI isn't logged in, log in with that CLI first.
`;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    agent: "claude",
    port: 7777,
    host: "0.0.0.0",
    code: null,
    cwd: process.cwd(),
    webDevUrl: null,
    fake: false,
    record: null,
    mode: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--port":
        options.port = Number.parseInt(next(), 10);
        break;
      case "--host":
        options.host = next();
        break;
      case "--code":
        options.code = next();
        break;
      case "--cwd":
        options.cwd = resolve(next());
        break;
      case "--web-dev-url":
        options.webDevUrl = next();
        break;
      case "--mode":
        options.mode = next();
        break;
      case "--record":
        options.record = resolve(next());
        break;
      case "--fake": {
        const peek = argv[i + 1];
        options.fake = peek && !peek.startsWith("--") ? ((i += 1), peek) : true;
        break;
      }
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be a valid port number");
  }
  return options;
}

function pairCode(fixed: string | null): string {
  if (fixed) return fixed;
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

async function gitBranch(cwd: string): Promise<string | null> {
  // `--show-current` also works on a repository with no commits yet, where
  // `rev-parse --abbrev-ref HEAD` fails on the unborn branch.
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
    const branch = stdout.trim();
    if (branch.length > 0) return branch;
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });
    const sha = stdout.trim();
    return sha.length > 0 ? `detached@${sha}` : null;
  } catch {
    return null;
  }
}

async function projectName(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
  } catch {
    // not a Node project; fall back to the directory name
  }
  return basename(cwd);
}

/**
 * Print the agent's own login command when it fails to start.
 *
 * Couchmode never builds a login flow of its own: authentication belongs to the
 * agent's CLI. This only ever reaches the terminal, never a connected client.
 */
function printLoginHint(definition: AgentDefinition): void {
  if (!definition.loginHint) return;
  process.stdout.write(
    `\nIf ${definition.name} is not logged in, log in with its own CLI first:\n\n    ${definition.loginHint}\n\n`,
  );
}

async function bridgeVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const FIXTURES_DIR = join(here, "..", "fixtures");

async function resolveFixturePath(value: string | boolean): Promise<string> {
  if (typeof value === "string") {
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
  const entries = (await readdir(FIXTURES_DIR).catch(() => [])).filter((n) => n.endsWith(".jsonl"));
  const first = entries.sort()[0];
  if (!first) {
    throw new Error(
      `--fake found no fixtures in ${FIXTURES_DIR}. Record one first: couchmode --record fixtures/demo.jsonl`,
    );
  }
  return join(FIXTURES_DIR, first);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const version = await bridgeVersion();
  const registry = await loadAgents();

  const definition: AgentDefinition | undefined = registry.get(options.agent);
  if (!definition) {
    const names = registry
      .list()
      .map((a) => a.name)
      .join(", ");
    throw new Error(`unknown agent "${options.agent}". Known agents: ${names}`);
  }

  const code = pairCode(options.code);
  const cwd = options.cwd;
  const [name, branch] = await Promise.all([projectName(cwd), gitBranch(cwd)]);
  const isFake = options.fake !== false;

  // The agent currently running. Switching replaces it; the ACP session does
  // not survive, because a session belongs to the agent that created it.
  let current: AgentDefinition = definition;

  /** Build the transport for one run: a fixture replay, or a spawned process. */
  async function createTransport(target: AgentDefinition): Promise<AgentLike> {
    let transport: AgentLike;
    if (isFake) {
      const fixturePath = await resolveFixturePath(options.fake);
      const fixture = await loadFixture(fixturePath);
      info(`fake mode: replaying ${fixturePath} (${fixture.entries.length} messages)`);
      transport = createFakeAgent(fixture);
    } else {
      info(`spawning ${target.command} ${target.args.join(" ")}`);
      transport = spawnAgent(target, cwd);
    }

    // Recording taps the ACP stream itself, so a `--fake` run records exactly
    // the same way a live one does. That is what makes a replay checkable
    // against the original: scripts/verify-fixture.mjs diffs the two.
    if (options.record) {
      const recorder = createRecorder(options.record, target.name, cwd);
      transport = { ...transport, stream: teeStream(transport.stream, recorder) };
      info(`recording to ${options.record}`);
      process.on("exit", () => void recorder.close());
    }
    return transport;
  }

  // --- server --------------------------------------------------------------
  const server = createHttpServer({
    webRoot: join(here, "..", "..", "web", "dist"),
    ...(options.webDevUrl ? { webDevUrl: options.webDevUrl } : {}),
  });

  let acp: CouchmodeAcpClient | null = null;

  const buildHello = (clients: ConnectedClient[]): ServerMessage => ({
    type: "hello",
    bridgeVersion: version,
    agentName: current.name,
    agentTitle: current.title ?? current.name,
    agentInfo: acp?.agentInfo ?? null,
    cwd,
    projectName: name,
    gitBranch: branch,
    clients,
    agents: registry.list().map((entry) => ({
      name: entry.name,
      title: entry.title ?? entry.name,
      active: entry.name === current.name,
    })),
    status: acp?.currentStatus ?? "starting",
    mode: acp?.modes
      ? {
          currentModeId: acp.modes.currentModeId,
          availableModes: acp.modes.availableModes.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description ?? null,
          })),
        }
      : null,
    fake: isFake,
  });

  const hub = new Hub(code, {
    buildHello,
    onSubmitPrompt: (text) => {
      const result = acp?.submitPrompt(text) ?? { accepted: false, reason: "agent not ready" };
      if (!result.accepted) {
        hub.broadcast({ type: "error", message: result.reason ?? "prompt rejected" });
      }
    },
    onPermissionDecision: (requestId, optionId, from) => {
      const ok = acp?.decidePermission(requestId, optionId, from) ?? false;
      if (!ok) log("ws", "--", `permission ${requestId.slice(0, 8)} already resolved`);
    },
    onCancel: () => acp?.cancel(),
    onSwitchAgent: (target) => void switchAgent(target),
  });
  hub.attach(server);

  /**
   * Bring up an agent and its ACP session. Safe to call again: the previous
   * agent is stopped first.
   *
   * Returns the error text when the agent could not be started, so the caller
   * can surface the agent's own words rather than inventing a message.
   */
  async function startAgent(target: AgentDefinition): Promise<string | null> {
    await acp?.stop();
    acp = null;
    current = target;

    const transport = await createTransport(target);
    acp = new CouchmodeAcpClient(
      transport,
      cwd,
      {
        onSessionUpdate: (notification) => hub.broadcast({ type: "acp", payload: notification }),
        onStatus: (status, detail) =>
          hub.broadcast({ type: "agent_status", status, ...(detail ? { detail } : {}) }),
        onPermissionRequest: (requestId, request) =>
          hub.broadcast({ type: "permission_request", requestId, request }),
        onPermissionResolved: (requestId, optionId, by) =>
          hub.broadcast({ type: "permission_resolved", requestId, optionId, by }),
      },
      version,
      options.mode ? [options.mode] : target.preferredModes,
    );

    try {
      await acp.start();
      info(`agent ready: ${target.name}`);
      hub.announce();
      return null;
    } catch (error) {
      const detail = errorText(error);
      const stderr = transport.stderr().trim();
      warn(`agent failed to start: ${detail}`);
      if (stderr) process.stdout.write(`\n--- agent output ---\n${stderr}\n--------------------\n`);
      printLoginHint(target);
      hub.broadcast({ type: "agent_status", status: "error", detail: stderr || detail });
      hub.announce();
      return stderr || detail;
    }
  }

  /** Swap to a different agent from agents.json, at a client's request. */
  async function switchAgent(targetName: string): Promise<void> {
    const target = registry.get(targetName);
    if (!target) {
      hub.broadcast({ type: "error", message: `unknown agent "${targetName}"` });
      return;
    }
    // Choosing the agent already running means "restart it" - useful when an
    // agent has wedged, and the only meaningful form of this in fake mode,
    // where there is one recording and nothing to switch to.
    const restarting = target.name === current.name;
    if (isFake && !restarting) {
      hub.broadcast({
        type: "error",
        message: "fake mode replays one recording; restart the bridge to change agents",
      });
      return;
    }

    info(
      restarting
        ? `restarting agent: ${target.name}`
        : `switching agent: ${current.name} -> ${target.name}`,
    );
    // Everything on screen belongs to a session that is about to end.
    hub.clearHistory();
    hub.broadcast({
      type: "session_reset",
      reason: restarting ? "agent_restarted" : "agent_switched",
    });
    hub.broadcast({ type: "agent_status", status: "starting" });
    await startAgent(target);
  }

  await new Promise<void>((done) => server.listen(options.port, options.host, done));

  const urls = lanAddresses().map((address) => `http://${address}:${options.port}`);
  banner([
    "  ┌─────────────────────────────────────────────┐",
    "  │  Couchmode - your coding agent, couch mode  │",
    "  └─────────────────────────────────────────────┘",
    "",
    `  pair code   ${code.split("").join(" ")}`,
    `  agent       ${definition.title ?? definition.name}${isFake ? "  (fake replay)" : ""}`,
    `  project     ${name}${branch ? ` @ ${branch}` : ""}`,
    `  directory   ${cwd}`,
    "",
    "  phone       " + (urls[0] ? `${urls[0]}/phone` : `http://localhost:${options.port}/phone`),
    "  tv          " + (urls[0] ? `${urls[0]}/tv` : `http://localhost:${options.port}/tv`),
    ...(urls.length > 1 ? urls.slice(1).map((u) => `              ${u}/phone`) : []),
    `  local       http://localhost:${options.port}/phone`,
    "",
    "  Couchmode doesn't handle credentials. It runs your agent's CLI, which",
    "  uses the login you already have.",
  ]);

  // Anyone who paired while the agent was still starting gets a corrected
  // `hello` from inside startAgent once the session exists.
  await startAgent(definition);

  const shutdown = () => {
    info("shutting down");
    void acp?.stop();
    hub.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (USER_AGENTS_PATH) log("config", "--", `user agents override: ${USER_AGENTS_PATH}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`couchmode: ${errorText(error)}\n`);
  process.exit(1);
});
