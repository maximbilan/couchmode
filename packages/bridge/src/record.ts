/**
 * Session recorder (`--record <file>`) and the stream tee it installs.
 *
 * Records raw ACP JSON-RPC messages in both directions with relative timings so
 * `--fake` can replay a real agent run without spending tokens. Absolute paths
 * are scrubbed and authentication traffic is dropped at write time, so fixtures
 * are safe to commit.
 */
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export type MessageDirection = "agent" | "client";

export interface FixtureHeader {
  kind: "couchmode-fixture";
  version: 1;
  agent: string;
  /** Always the scrubbed placeholder, never a real path. */
  cwd: string;
  recordedAt: string;
}

export interface FixtureEntry {
  /** Milliseconds since the first recorded message. */
  t: number;
  /** `agent` = agent -> bridge, `client` = bridge -> agent. */
  dir: MessageDirection;
  msg: AnyMessage;
}

/** Placeholder that replaces the recorded project directory in fixtures. */
export const SCRUBBED_CWD = "/project";
const SCRUBBED_HOME = "/home/user";

export function createScrubber(cwd: string): (value: unknown) => unknown {
  const home = homedir();
  const replace = (text: string): string => {
    let out = text.split(cwd).join(SCRUBBED_CWD);
    if (home && home !== "/") out = out.split(home).join(SCRUBBED_HOME);
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) result[key] = walk(child);
      return result;
    }
    return value;
  };

  return walk;
}

/**
 * Methods never written to a fixture.
 *
 * `authenticate` is the ACP auth method; `_auth/*` is an agent extension (the
 * Claude adapter reports which credential source it picked). Neither carries a
 * secret value, but recordings are committed to git, so authentication traffic
 * simply does not belong in them.
 */
function isAuthTraffic(message: AnyMessage): boolean {
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" && (method === "authenticate" || method.startsWith("_auth/"));
}

export interface Recorder {
  record(dir: MessageDirection, message: AnyMessage): void;
  close(): Promise<void>;
}

export function createRecorder(path: string, agent: string, cwd: string): Recorder {
  const file: WriteStream = createWriteStream(path, { encoding: "utf8" });
  const scrub = createScrubber(cwd);
  let start: number | null = null;

  const header: FixtureHeader = {
    kind: "couchmode-fixture",
    version: 1,
    agent,
    cwd: SCRUBBED_CWD,
    recordedAt: new Date().toISOString(),
  };
  file.write(`${JSON.stringify(header)}\n`);

  return {
    record(dir, message) {
      if (isAuthTraffic(message)) return;
      start ??= Date.now();
      const entry: FixtureEntry = {
        t: Date.now() - start,
        dir,
        msg: scrub(message) as AnyMessage,
      };
      file.write(`${JSON.stringify(entry)}\n`);
    },
    close() {
      return new Promise((resolve) => file.end(resolve));
    },
  };
}

/**
 * Wrap an ACP stream so every message passing through is handed to `recorder`.
 * The bridge's ACP client is unaware this exists.
 */
export function teeStream(stream: Stream, recorder: Recorder): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        recorder.record("agent", message);
        controller.enqueue(message);
      },
    }),
  );

  const outbound = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      recorder.record("client", message);
      controller.enqueue(message);
    },
  });
  void outbound.readable.pipeTo(stream.writable).catch(() => {});

  return { readable, writable: outbound.writable };
}
