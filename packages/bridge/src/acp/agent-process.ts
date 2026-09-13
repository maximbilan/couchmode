/**
 * Spawns an ACP agent as a child process and exposes its stdio as an ACP
 * `Stream` of JSON-RPC messages.
 *
 * ACP transport: "Agents ... typically run as subprocesses of the Client",
 * speaking newline-delimited JSON-RPC 2.0 over stdin/stdout. stderr is NOT part
 * of the protocol - agents use it for human-readable diagnostics, which is where
 * an unauthenticated CLI reports itself.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import type { AgentDefinition } from "../config/agents.js";

/** How much agent stderr we keep so we can surface its own error text. */
const STDERR_LIMIT = 8_000;

export interface AgentTransport {
  stream: Stream;
  /** Agent-authored diagnostics. Surfaced verbatim; contains no Couchmode state. */
  stderr(): string;
  /** Resolves with the exit code / signal once the child is gone. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export function spawnAgent(definition: AgentDefinition, cwd: string): AgentTransport {
  const child: ChildProcessWithoutNullStreams = spawn(definition.command, definition.args, {
    cwd,
    // The agent CLI reuses whatever login it already has, which lives in the
    // user's environment and home directory. We pass the ambient environment
    // through untouched and never read, log, or forward any of its values.
    env: { ...process.env, ...definition.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-STDERR_LIMIT);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  // Keep a listener so an EPIPE after the child dies never crashes the bridge.
  child.stdin.on("error", () => {});

  // ndJsonStream(output, input): first argument is what WE write to the agent,
  // second is what we read from it.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  return {
    stream,
    stderr: () => stderrBuffer,
    exited,
    kill: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
