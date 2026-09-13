# ACP on a TV

How Agent Client Protocol concepts map to a 10-foot UI.

Couchmode does not invent a protocol. It implements ACP **v1** faithfully and
renders it for a screen three metres away, driven by a five-button remote. This
document records every mapping decision, so the translation is reviewable
instead of implicit.

Spec: <https://agentclientprotocol.com>. SDK: `@agentclientprotocol/sdk@1.4.0`
(its default export is protocol v1; v2 exists only as a draft behind
`experimental/v2`).

## Who is the client?

The **bridge is the ACP client**. The TV and the phone are viewers attached to
it over a LAN WebSocket.

```
 agent process  <--stdio JSON-RPC-->  bridge (ACP client)  <--WebSocket-->  TV / phone
```

This is forced by the protocol, not a preference. ACP client-side methods
require the ability to spawn processes and touch the filesystem
(`fs/read_text_file`, `fs/write_text_file`, `terminal/*`). A Fire TV cannot do
either for your MacBook's project directory. So the machine that owns the code
is the client, and the TV renders what it is told.

One consequence worth stating plainly: **a client disconnecting never affects
the agent**. The ACP session lives in the bridge. Turning the TV off mid-turn
does not cancel anything.

## Methods Couchmode calls on the agent

| ACP method         | When                           | Notes                                                                             |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------- |
| `initialize`       | once, at startup               | `protocolVersion: 1`, `clientCapabilities.fs.{readTextFile,writeTextFile} = true` |
| `session/new`      | once, after initialize         | `{ cwd, mcpServers: [] }` — `cwd` is the directory `couchmode` was started in     |
| `session/set_mode` | after `session/new`, if needed | see [Session modes](#session-modes-the-one-that-matters)                          |
| `session/prompt`   | per user prompt                | `prompt: [{ type: "text", text }]`                                                |
| `session/cancel`   | on cancel (notification)       | no response; we also resolve pending permissions as `cancelled`                   |

## Methods Couchmode answers for the agent

| ACP method                      | Handling                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `session/update` (notification) | forwarded to every paired client **unchanged**, wrapped only as `{type:"acp", payload}`                      |
| `session/request_permission`    | broadcast to all clients, first valid answer wins, see [Permissions](#permissions-the-remote-control-moment) |
| `fs/read_text_file`             | read, scoped to `cwd`; honours the 1-based `line` and `limit` params                                         |
| `fs/write_text_file`            | write, scoped to `cwd`, creating the file if absent                                                          |

Capabilities we deliberately **do not** advertise, and therefore must never be
called (ACP: clients and agents "MUST treat all capabilities omitted in the
`initialize` request as UNSUPPORTED"):

- `terminal` — no `terminal/*` implementation yet. Agents fall back to running
  commands themselves and reporting them as `kind: "execute"` tool calls, which
  is what the TV shows today. Planned for a later milestone.
- `elicitation` — structured input is a keyboard-shaped interaction; the phone
  is the natural home for it, not the remote.

## Session modes: the one that matters

`session/new` may return a `SessionModeState`. The spec notes modes "often
affect ... whether they request permission before running", and that turns out
to decide whether Couchmode has anything to do at all.

The Claude adapter starts a session in mode **`auto`** — _"Claude handles
permission decisions"_. A recorded run in that mode produced **zero**
`session/request_permission` calls: the agent read files, ran `npm test` and
rewrote `README.md` without ever asking. On a TV that is a screensaver.

So after `session/new`, Couchmode switches to the first mode from the agent's
own `availableModes` that matches the per-agent `preferredModes` list in
`agents.json` (`["default", "ask"]` for Claude — "Manual: always ask before
making changes"). The same run in `default` produced two permission requests and
a diff-bearing edit. Override with `--mode <id>`; if none of the preferred modes
are offered, Couchmode leaves the session as it found it and logs a warning.

This is the single most important mapping decision in the project: **approving
tool calls from the couch is the product, so the session has to be in a mode
that asks.**

Note: the spec marks the dedicated mode methods as eventually superseded by
[session config options](https://agentclientprotocol.com/protocol/v1/session-config-options).
The Claude adapter advertises both (`modes` and a `configOptions` entry with
`category: "mode"`). Couchmode uses `session/set_mode` because it is the stable
v1 path; moving to `session/set_config_option` is a follow-up.

## `session/update` types

Every `sessionUpdate` discriminator, and what the TV does with it.

### Rendered

| `sessionUpdate`             | 10-foot treatment                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`       | main activity feed, basic markdown. Chunks sharing a `messageId` are coalesced into one block; a changed `messageId` starts a new one. In a real recorded run this turned **50 chunks into 2 readable blocks**. |
| `user_message_chunk`        | right-aligned block, so you can see what the phone sent                                                                                                                                                         |
| `agent_thought_chunk`       | collapsed by default, dimmed and italic. Thinking is reassuring at a glance and unreadable in bulk from a sofa.                                                                                                 |
| `tool_call`                 | one compact row: kind icon + title + status                                                                                                                                                                     |
| `tool_call_update`          | patches the existing row by `toolCallId`. Per spec, only changed fields are present, so each field is applied only when defined.                                                                                |
| `plan`                      | a checklist block; entry `status` drives strike-through and colour                                                                                                                                              |
| `available_commands_update` | stored for a future slash-command picker; not drawn yet                                                                                                                                                         |

### Accepted and deliberately not drawn

Listing these explicitly means an unrecognised update is a visible gap rather
than a silent drop. The client logs each one once with its reason.

| `sessionUpdate`                                 | why not                                               |
| ----------------------------------------------- | ----------------------------------------------------- |
| `usage_update`                                  | token/cost counters are planned for the TV top bar    |
| `session_info_update`                           | title changes do not affect the 10-foot layout yet    |
| `config_option_update`                          | model/mode pickers are desk-UI concerns for now       |
| `current_mode_update`                           | mode switching from the TV is a later milestone       |
| `compaction_update`, `compaction_summary_chunk` | context compaction is invisible to a viewer           |
| `plan_update`, `plan_removed`                   | incremental plan edits fold into the last full `plan` |

## Tool calls

`ToolKind` exists precisely so a client can choose an icon, which is exactly
what a 10-foot UI needs:

| kind     | icon | kind      | icon |
| -------- | ---- | --------- | ---- |
| `read`   | 📖   | `execute` | ▶    |
| `edit`   | ✏️   | `think`   | 💭   |
| `delete` | 🗑    | `fetch`   | 🌐   |
| `move`   | 📦   | `other`   | 🔧   |
| `search` | 🔍   |           |      |

`ToolCallContent` of `type: "diff"` carries whole-file `oldText`/`newText`, not
a unified patch, so the client computes the line diff itself (LCS, with a
whole-file-replacement fallback for pathological sizes). It renders in the TV's
right-hand panel with `+N −M` in the header.

`type: "terminal"` content is not rendered yet — it requires the `terminal`
capability we do not advertise.

## Permissions: the remote-control moment

This is the interaction Couchmode exists for.

1. The agent calls `session/request_permission`. The call **blocks** until the
   client answers — the agent is idle, waiting on a human.
2. The bridge mints its own `requestId` and broadcasts the ACP request
   **verbatim** to every paired client.
3. The TV steals focus with a modal; the phone shows the same request inline.
   Both render the agent's `options[]` **in the order given**, using each
   option's `kind` for colour and default focus. Couchmode never adds an option
   the agent did not offer — including "always allow", which only appears when
   the agent supplies an `allow_always` option of its own.
4. The **first valid answer wins**. Everyone else's copy closes with
   `permission_resolved`, showing who answered.
5. The response is `{ outcome: { outcome: "selected", optionId } }`.

Default focus is a heuristic on the tool: allow-type option for read-only kinds,
deny-type for `execute`. Back/Escape always maps to the deny option.

Two rules the spec is strict about, and Couchmode follows:

- On `session/cancel`, every pending permission request **must** be answered
  with `{ outcome: { outcome: "cancelled" } }`.
- A client may auto-answer. Couchmode only does so on a **10-minute timeout**,
  and only in the denying direction: first `reject_once`, else `reject_always`,
  else the last option. Nothing is ever auto-allowed by inactivity.

## Paths

ACP requires every path to be absolute and every line number to be 1-based.
Couchmode additionally refuses any path that resolves outside the session `cwd`
(symlinks resolved first), returning a JSON-RPC `invalidParams` error. A
relative path is treated as a protocol violation rather than being guessed at.

## Recording and replay

`--record <file>` tees the raw JSON-RPC stream to a `.jsonl` fixture, scrubbing
the project directory to `/project` and the home directory to `/home/user`, and
dropping authentication traffic (`authenticate`, `_auth/*`) entirely.

`--fake` replays a fixture as an ACP `Stream`, so the bridge's client code path
is unchanged — it still calls `initialize`, `session/new` and `session/prompt`,
and still answers `session/request_permission`. Causal order is preserved by
blocking the replay on each recorded client **request** until the live bridge
issues that same method, so nothing streams until a real user actually prompts.

`node scripts/verify-fixture.mjs <original> <replay>` diffs the agent→client
streams of a recording and its replay, normalising JSON-RPC ids and timing.
