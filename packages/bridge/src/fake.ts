/**
 * FAKE mode: replay a recorded ACP session instead of spawning an agent.
 *
 * The replay presents itself as an ACP `Stream`, so the bridge's ACP client code
 * is byte-for-byte the same path as a live run - it still calls `initialize`,
 * `session/new`, `session/prompt`, still answers `session/request_permission`.
 *
 * Causal ordering is preserved by walking the fixture in file order and blocking
 * on each recorded client REQUEST until the live bridge actually sends that
 * method. So the stream of `session/update` notifications recorded after
 * `session/prompt` does not start flowing until a real user submits a prompt.
 */
import { readFile } from "node:fs/promises";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { FixtureEntry, FixtureHeader } from "./record.js";
import { info, warn } from "./log.js";

/** Never sit idle longer than this between replayed messages. */
const MAX_GAP_MS = 2_500;

export interface Fixture {
  header: FixtureHeader;
  entries: FixtureEntry[];
}

export async function loadFixture(path: string): Promise<Fixture> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const [headerLine, ...rest] = lines;
  if (!headerLine) throw new Error(`fixture ${path} is empty`);

  const header = JSON.parse(headerLine) as FixtureHeader;
  if (header.kind !== "couchmode-fixture") {
    throw new Error(`fixture ${path} is missing its couchmode-fixture header`);
  }
  return { header, entries: rest.map((line) => JSON.parse(line) as FixtureEntry) };
}

type JsonRpcish = {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
};

const isRequest = (m: JsonRpcish): boolean =>
  m.method !== undefined && m.id !== undefined && m.id !== null;
const isNotification = (m: JsonRpcish): boolean =>
  m.method !== undefined && (m.id === undefined || m.id === null);
const isResponse = (m: JsonRpcish): boolean =>
  m.method === undefined && m.id !== undefined && m.id !== null && ("result" in m || "error" in m);

export interface FakeAgent {
  stream: Stream;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export function createFakeAgent(fixture: Fixture, speed = 1): FakeAgent {
  let controller: ReadableStreamDefaultController<AnyMessage> | null = null;
  let stopped = false;

  /** recorded request id -> id the live bridge actually used */
  const idMap = new Map<string | number, string | number>();
  /** live requests the bridge has sent that no recorded entry has claimed yet */
  const unclaimed: Array<{ method: string; id: string | number }> = [];
  /** waiters parked on a recorded client request, keyed in arrival order */
  const waiters: Array<{ method: string; resolve: (id: string | number) => void }> = [];
  /** agent->bridge requests we emitted and are waiting to be answered */
  const awaitingResponse = new Map<string | number, () => void>();

  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });

  let replayDone = false;
  let fakeIdCounter = 100_000;

  const emit = (message: AnyMessage): void => {
    if (stopped) return;
    controller?.enqueue(message);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  /** Park until the bridge sends a live request with this method. */
  const waitForLiveRequest = (method: string): Promise<string | number> => {
    const index = unclaimed.findIndex((entry) => entry.method === method);
    if (index >= 0) {
      const [claimed] = unclaimed.splice(index, 1);
      return Promise.resolve(claimed!.id);
    }
    return new Promise((resolve) => waiters.push({ method, resolve }));
  };

  const handleFromBridge = (message: AnyMessage): void => {
    const m = message as JsonRpcish;

    if (isRequest(m)) {
      const method = m.method!;
      const id = m.id!;
      const waiterIndex = waiters.findIndex((waiter) => waiter.method === method);
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        waiter!.resolve(id);
      } else {
        unclaimed.push({ method, id });
      }

      // Once the fixture is exhausted, keep the UI usable: answer further
      // prompts with a real ACP end_turn rather than hanging forever.
      if (replayDone && method === "session/prompt") {
        void answerExhaustedPrompt(id);
      }
      return;
    }

    if (isResponse(m)) {
      const resolve = awaitingResponse.get(m.id!);
      if (resolve) {
        awaitingResponse.delete(m.id!);
        resolve();
      }
    }
  };

  const answerExhaustedPrompt = async (id: string | number): Promise<void> => {
    const sessionId = findSessionId();
    await sleep(200);
    if (sessionId) {
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "_(fake mode: the recorded session is finished — restart the bridge to replay it again)_",
            },
          },
        },
      } as unknown as AnyMessage);
    }
    emit({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } } as unknown as AnyMessage);
  };

  /** The sessionId the fixture's `session/new` response handed out. */
  const findSessionId = (): string | null => {
    for (const entry of fixture.entries) {
      const result = (entry.msg as JsonRpcish).result as { sessionId?: string } | undefined;
      if (entry.dir === "agent" && result?.sessionId) return result.sessionId;
    }
    return null;
  };

  const run = async (): Promise<void> => {
    let lastT = 0;
    for (const entry of fixture.entries) {
      if (stopped) return;
      const m = entry.msg as JsonRpcish;

      if (entry.dir === "client") {
        // Block the replay until the live bridge issues this same call.
        if (isRequest(m)) {
          const liveId = await waitForLiveRequest(m.method!);
          idMap.set(m.id!, liveId);
          lastT = entry.t;
        }
        // Recorded client notifications (e.g. session/cancel) and recorded
        // client responses are not awaited: the live run may never produce them.
        continue;
      }

      const gap = Math.min(Math.max(entry.t - lastT, 0), MAX_GAP_MS) / speed;
      lastT = entry.t;
      if (gap > 0) await sleep(gap);
      if (stopped) return;

      if (isResponse(m)) {
        const liveId = idMap.get(m.id!);
        if (liveId === undefined) {
          warn(`fake: no live request matched recorded response id ${String(m.id)}; skipping`);
          continue;
        }
        emit({ ...(entry.msg as object), id: liveId } as AnyMessage);
        continue;
      }

      if (isRequest(m)) {
        // An agent -> client request (session/request_permission, fs/*).
        // Give it a fresh id and wait for the bridge to answer, exactly as the
        // real agent would block.
        const id = fakeIdCounter++;
        const wait = new Promise<void>((resolve) => awaitingResponse.set(id, resolve));
        emit({ ...(entry.msg as object), id } as AnyMessage);
        await wait;
        continue;
      }

      if (isNotification(m)) emit(entry.msg);
    }

    replayDone = true;
    info("fake: fixture replay complete");
  };

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c;
      void run().catch((error: unknown) => {
        warn(`fake: replay failed: ${(error as Error).message}`);
      });
    },
    cancel() {
      stopped = true;
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      handleFromBridge(message);
    },
  });

  return {
    stream: { readable, writable },
    stderr: () => "",
    exited,
    kill: () => {
      stopped = true;
      for (const resolve of awaitingResponse.values()) resolve();
      awaitingResponse.clear();
      try {
        controller?.close();
      } catch {
        // already closed
      }
      resolveExit({ code: 0, signal: null });
    },
  };
}
