# Upstream issues and gaps

Minimal repros for bugs or gaps found in ACP, the TypeScript SDK, or agent
adapters while building Couchmode. Each one is a candidate for an upstream
issue or PR.

## Observations so far

Nothing here is a bug — these are documented behaviours that surprised us, kept
for the record.

### The Claude adapter starts sessions in a mode that never asks for permission

- **Where:** `@agentclientprotocol/claude-agent-acp@0.76.0`
- **What:** `session/new` returns `modes.currentModeId = "auto"`
  ("Claude handles permission decisions"). A client that does not call
  `session/set_mode` receives **zero** `session/request_permission` calls, even
  for shell commands and file edits.
- **Repro:** connect as a client, `initialize`, `session/new`, then
  `session/prompt` with a task that edits a file. Observe `session/update`
  tool calls with `kind: "execute"` completing without any permission request.
  Call `session/set_mode` with `modeId: "default"` first and the same prompt
  produces `session/request_permission` for both the edit and the command.
- **Assessment:** working as designed and discoverable from the `session/new`
  response, but it is a sharp edge for any client whose entire UI is permission
  approval. Possibly worth a note in the adapter README.
- **Our handling:** `preferredModes` in `agents.json`; see
  [`acp-on-tv.md`](./acp-on-tv.md#session-modes-the-one-that-matters).

### `node >= 22` is required by the Claude adapter

- **Where:** `@agentclientprotocol/claude-agent-acp@0.76.0` `engines.node`
- **What:** the adapter requires Node 22+, so a bridge running on Node 20 can
  start but the spawned agent fails.
- **Our handling:** the whole repo declares `engines.node >= 22`.
