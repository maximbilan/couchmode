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

### `gemini --acp` hangs silently when folder trust cannot be granted

- **Where:** Gemini CLI 0.46.0
- **What:** started in ACP mode in an untrusted directory, the agent writes
  **nothing** to stdout or stderr and never answers `initialize`. In normal
  (non-ACP) mode the same CLI prints a clear message naming `--skip-trust`.
- **Repro:** in a directory the CLI has not been told to trust, spawn
  `gemini --acp`, write one line of JSON to its stdin and read for 30 seconds:

  ```json
  {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {
      "protocolVersion": 1,
      "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } }
    }
  }
  ```

  Nothing arrives on stdout or stderr. Add `--skip-trust` and the same request
  is answered immediately. Running the CLI without `--acp` in the same
  directory prints a message naming the flag.

- **Assessment:** a client cannot distinguish this from a slow start, and there
  is no error text to show a user. Emitting the same message it already writes
  in interactive mode, or exiting non-zero, would make it diagnosable.
- **Our handling:** `--skip-trust` in the bundled `agents.json`, plus a 30s
  handshake timeout in the bridge so any silent agent surfaces as an error
  rather than an indefinite "Starting".

### `--experimental-acp` is deprecated in Gemini CLI

- **Where:** Gemini CLI 0.46.0
- **What:** `--experimental-acp` still works but prints a deprecation notice
  pointing at `--acp`. Documentation and third-party guides still widely say
  `--experimental-acp`.
- **Our handling:** the bundled `agents.json` uses `--acp`.

### `node >= 22` is required by the Claude adapter

- **Where:** `@agentclientprotocol/claude-agent-acp@0.76.0` `engines.node`
- **What:** the adapter requires Node 22+, so a bridge running on Node 20 can
  start but the spawned agent fails.
- **Our handling:** the whole repo declares `engines.node >= 22`.

### Bedrock mode hangs on `session/prompt` when AWS credentials are expired

- **Where:** `@agentclientprotocol/claude-agent-acp@0.79.0` with
  `CLAUDE_CODE_USE_BEDROCK=1`
- **What:** with expired AWS credentials in the environment, `initialize` and
  `session/new` both succeed normally — and then `session/prompt` never
  returns. No `session/update`, no error, no stderr mentioning AWS, Bedrock or
  credentials. The identical prompt against the same adapter without
  `CLAUDE_CODE_USE_BEDROCK` finishes in a couple of seconds.
- **Repro:** export credentials that `aws sts get-caller-identity` rejects with
  `InvalidClientTokenId`, then spawn the adapter with
  `CLAUDE_CODE_USE_BEDROCK=1`, `initialize`, `session/new`, and prompt it to
  create a file. Observed: nothing for 120s. One hint is visible in the
  adapter's own stderr — the `sdk-initialize` phase takes ~2.8s rather than
  ~0.3s, which is the AWS credential chain being walked — but it is a timing
  difference, not a message.
- **Assessment:** an auth failure that presents as a hang is the worst shape for
  a 10-foot UI, because the screen just says the agent is thinking. The Gemini
  case above is the same class of problem at a different point in the
  lifecycle, and the fix is the same: say something on stderr, or fail the
  request.
- **Our handling:** none yet. Couchmode has no Bedrock-specific entry — Bedrock
  is configured in Claude Code and the `claude` agent inherits it — so this
  reaches anyone who sets it up there. The bridge's 30s handshake timeout does
  **not** cover it: that bounds `initialize` and `session/new`, and this hang is
  in `session/prompt`, which is legitimately unbounded because a real turn can
  take minutes. The README says to check credentials when an agent sits on
  "Thinking". A prompt-level idle timeout — no `session/update` at all within N
  seconds of a prompt — is the obvious follow-up, and would cover any agent that
  goes silent, not just this one.
