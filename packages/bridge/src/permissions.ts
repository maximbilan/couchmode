/**
 * Pending ACP `session/request_permission` requests.
 *
 * The agent calls this client-side method and blocks until we answer. We
 * broadcast the request to every paired client; the first valid answer wins and
 * the rest are told it is resolved.
 *
 * Response shape (ACP `RequestPermissionResponse`):
 *   { outcome: { outcome: "selected", optionId } }
 *   { outcome: { outcome: "cancelled" } }
 */
import { randomUUID } from "node:crypto";
import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ClientType } from "./protocol.js";

export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export type ResolvedBy = ClientType | "timeout" | "cancelled";

export interface PendingPermission {
  requestId: string;
  /** The ACP request exactly as received, forwarded to clients unchanged. */
  request: unknown;
  options: PermissionOption[];
}

interface Entry extends PendingPermission {
  settle: (response: RequestPermissionResponse, by: ResolvedBy, optionId: string | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Pick the option to fall back to when nobody answers in time.
 * Prefer an explicit one-shot rejection, then a remembered rejection; if the
 * agent offered neither, deny by taking the last option rather than allowing.
 */
export function denyOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always") ??
    options.at(-1)
  );
}

export class PermissionRegistry {
  private readonly pending = new Map<string, Entry>();

  constructor(
    private readonly onResolved: (
      requestId: string,
      optionId: string | null,
      by: ResolvedBy,
    ) => void,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * Register an incoming permission request and return the promise the ACP
   * handler awaits, plus the bridge-minted id used to correlate a decision.
   */
  open(
    request: unknown,
    options: PermissionOption[],
  ): { requestId: string; response: Promise<RequestPermissionResponse> } {
    const requestId = randomUUID();
    let settled = false;

    const response = new Promise<RequestPermissionResponse>((resolve) => {
      const settle = (
        value: RequestPermissionResponse,
        by: ResolvedBy,
        optionId: string | null,
      ) => {
        if (settled) return;
        settled = true;
        const entry = this.pending.get(requestId);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(requestId);
        resolve(value);
        this.onResolved(requestId, optionId, by);
      };

      const timer = setTimeout(() => {
        const fallback = denyOption(options);
        settle(
          fallback
            ? { outcome: { outcome: "selected", optionId: fallback.optionId } }
            : { outcome: { outcome: "cancelled" } },
          "timeout",
          fallback?.optionId ?? null,
        );
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(requestId, { requestId, request, options, settle, timer });
    });

    return { requestId, response };
  }

  /**
   * Apply a client's decision. Returns false when the request is unknown
   * (already answered by someone else) or the option was not one the agent offered.
   */
  decide(requestId: string, optionId: string, by: ClientType): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (!entry.options.some((option) => option.optionId === optionId)) return false;
    entry.settle({ outcome: { outcome: "selected", optionId } }, by, optionId);
    return true;
  }

  /**
   * ACP: "The Client MUST respond to all pending `session/request_permission`
   * requests with the `cancelled` outcome" when it sends `session/cancel`.
   */
  cancelAll(): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle({ outcome: { outcome: "cancelled" } }, "cancelled", null);
    }
  }
}
