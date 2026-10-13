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
  is what the TV shows today. Not implemented yet.
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
| `current_mode_update`                           | mode switching from the TV is not built yet           |
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

### Which button the remote starts on

ACP gives each option a `kind`, which is the hint a client needs to pick a
default. Couchmode classifies the request in three, not two:

| class         | from                                                 | default focus         |
| ------------- | ---------------------------------------------------- | --------------------- |
| `read_only`   | kind `read`, `search`, `fetch`, `think`              | first allow option    |
| `destructive` | kind `execute` or `delete`, or a shell-looking title | first **deny** option |
| `modifying`   | kind `edit`, `move`, `other`, or unset               | first allow option    |

An edit is neither a read nor a shell command, and collapsing it into either
gets the default wrong. Edits start on allow because the diff is already on
screen beside the modal and the viewer is watching it happen; anything that
runs a command or deletes starts on deny, so a reflexive OK press can never
execute something.

The title heuristic exists for agents that leave `kind` unset: a title matching
a shell command shape (`rm`, `sudo`, `git`, a pipe, a redirect) is treated as
destructive.

Back/Escape is always the deny option, whatever the default was, so the
cautious answer is never more than one press away.

Two rules the spec is strict about, and Couchmode follows:

- On `session/cancel`, every pending permission request **must** be answered
  with `{ outcome: { outcome: "cancelled" } }`.
- A client may auto-answer. Couchmode only does so on a **10-minute timeout**,
  and only in the denying direction: first `reject_once`, else `reject_always`,
  else the last option. Nothing is ever auto-allowed by inactivity.

## The 10-foot layout

Sized for 1920x1080 at about three metres: body text 28px, the permission
summary 44px, every actionable control at least 64px tall, and a 3px focus ring
in a colour used for nothing else.

```
┌─ project · branch ───────────────── agent · status · clients ─┐
│                                                               │
│  Activity (60%)                    │  Changes (40%)           │
│  agent text, tool rows, plan       │  latest diff, +N −M      │
│                                    │                          │
├───────────────────────────────────────────────────────────────┤
│  Ask the agent… (or type on your phone)            [ Stop ]   │
└───────────────────────────────────────────────────────────────┘
```

### Focus is spatial, not tab order

A remote has four arrows, Enter and Back. Tab order cannot express "the thing to
the right of this", so focus moves by geometry: from the focused element's rect,
pick the nearest candidate whose centre lies in the pressed direction, weighting
cross-axis drift heavily so "right" prefers a true neighbour.

Panels are scrollers: up/down pan their content and only release the key back to
the focus manager once the edge is reached, so focus leaves a panel exactly when
there is nothing left to scroll.

That rule alone does not survive a long conversation. An hour of transcript is
many screens tall, so "leave the panel" costs a press per screen, and while the
agent is streaming the bottom moves away faster than a fixed step can chase it —
the prompt bar becomes unreachable in proportion to how much the agent has done.
Three things bound it:

- a press moves ~85% of the visible height, not a fixed 220px;
- consecutive presses accelerate, so a held button covers a long feed in a
  second — which is also why the pan is instant rather than smooth: a remote
  repeats the key every few dozen milliseconds and queued animations would lag
  behind the viewer;
- **Back returns to the present** whatever is on screen, re-pinning the feed to
  the newest item. The prompt bar is then one press down: two presses from
  anywhere, independent of length.

Left and right stay within a row. Without that rule, pressing right from the
activity feed with no diff panel beside it jumped up to the agent name in the
top bar — the only focusable thing further right on the screen. Horizontal moves
now require the candidate to overlap the current element's vertical range;
vertical moves may leave the column, since that is the only way to reach a
control that is not directly above or below.

A permission request pushes a focus _layer_. Only the top layer is navigable, so
the feed underneath cannot be reached by accident while the agent is blocked
waiting for an answer.

### What the feed does with each item

- **Agent text** renders as a small markdown subset: headings, fenced code,
  bullets, inline code, bold. A 10-foot UI needs very little of it.
- **Thoughts** are clamped to two lines. Reasoning is reassuring at a glance and
  unreadable in bulk from a sofa; Enter on the Activity panel expands them all.
- **Tool calls** are one compact row each: kind icon, title, status. Titles can
  be whole heredocs, so the row shows the first line only.
- **Plans** render as a checklist, with entry `status` driving the mark and
  strike-through.

The feed auto-scrolls, unless the viewer has deliberately scrolled up to read,
in which case it stops until they return to the bottom. A chip in the corner
says so and counts what has arrived since, because a feed that has quietly
stopped being live looks exactly like one where nothing is happening.

Unpinning happens on the key press, not on the scroll event it produces. A pan
that waits to be told it moved can be dragged back to the bottom by an item
arriving mid-scroll — the viewer presses up and the transcript yanks them down
again.

### The status pill

"Running tool" is not an ACP status and not a bridge status - it is derived on
the client from `prompting` plus any tool call in `in_progress`. From across a
room, "Thinking" and "running your test suite" should not look the same.

### The diff panel

Shows the most recent `type: "diff"` tool-call content, with the path and
`+N −M` in the header. It is capped at 400 rendered lines; a whole-file diff can
be thousands, and nobody reads that from a sofa.

It is not on screen until there is a diff to put in it. Forty per cent of a
television saying "no file changes yet" is forty per cent wasted, so the panel
appears when the first diff arrives and the activity feed takes the full width
until then. Focus follows: the panel cannot be reached while it is absent, and
focus leaves it if it disappears underneath.

## Switching agents ends the session

ACP has no notion of handing a session from one agent to another, and it
should not: a `sessionId` is issued by `session/new` on a particular agent and
means nothing to any other. So when a client asks for a different agent, the
bridge stops the current process, spawns the new one, and runs the whole
handshake again — `initialize`, `session/new`, `session/set_mode`.

Everything on screen belonged to the old session, so the bridge clears its
replay buffer and sends `session_reset`; clients drop their transcript and
diff. The picker says this will happen before you choose it, because a TV that
silently empties itself is alarming.

Choosing the agent already running restarts it — the same teardown, a fresh
session. `--fake` allows exactly that and refuses anything else: a recording is
one agent's session, and pretending otherwise would be a lie about what is on
screen.

Two details this got wrong at first, both found by using it rather than testing
it:

- **A stopped client has to go silent.** Killing an agent makes its `exited`
  promise resolve a moment later, and the stopped client was still wired to the
  hub — so it broadcast `agent_status: exited`, carrying the dead agent's
  stderr, _after_ its replacement had already reported ready. Switching agents
  looked like the new agent had crashed. A stopped client now emits nothing.
- **The reset has to tear down overlays, not just the transcript.** A
  permission modal left on screen holds a focus layer and its `requestId`, so
  the remote sat behind a dialog describing a session that had ended and no
  later request could ever be shown. `session_reset` now removes the modal and
  the picker, clears the pending queue, and returns focus to the base layer.
- **A switch has to narrate itself.** Clearing the screen and waiting several
  seconds for a process to spawn is indistinguishable from a crash. The reset
  carries the incoming agent's name — the corrected `hello` only arrives once
  the new agent is up — so the top bar can show it starting, a rule across the
  feed can say which agent the new session belongs to and what it replaced, and
  a banner can confirm when it is ready to take a prompt.

## Reconnecting

A client that drops is a client that must come back without lying about what it
missed. Three parts:

- **Noticing.** A closed socket fires `close`; a socket that has merely gone
  quiet does not. A sleeping TV or an access point handing the client to another
  radio leaves a connection the browser still calls open and the bridge never
  hears from again, so the client sends `{"type":"ping"}` every 15 seconds and
  drops the socket itself when a whole cycle plus grace passes with nothing
  heard. Without it the screen sits on a frozen transcript indefinitely.
- **Saying so.** The top bar states the link in words and counts down to the
  next attempt, and the agent's status is dimmed while the link is down —
  "Thinking" is a claim about the past once we cannot hear the bridge.
- **Rebuilding, not appending.** Pairing always replays the session so far, and
  a reconnect re-pairs, so a client that keeps its transcript ends up with two
  copies of every message and a duplicate modal for every pending approval. The
  hub now brackets the replay with `replay_start` / `replay_end`; clients clear
  on the first and settle on the second, rebuilding from the buffer each time.

`replay_end` is where the empty state is decided, not `replay_start`: the count
includes `agent_status` messages, so a bridge that has only said "ready" replays
a non-zero number of messages that produce no transcript at all.

## Handshake timeouts

An agent that cannot start is not always an agent that says so. `gemini --acp`
writes nothing at all — no stdout, no stderr — when its folder-trust check
cannot be satisfied; it simply never replies to `initialize`. Left alone, the
bridge would wait forever and the TV would sit on "Starting" with nothing to
show and nothing to explain.

So `initialize` and `session/new` are bounded (30s). On timeout the agent
process is killed and the failure is surfaced as an `agent_status` error, with
the agent's own stderr when it produced any, and its login command printed in
the terminal.

## Dictation is the keyboard's job

There is no in-page microphone. Browsers expose speech recognition only in a
secure context, and the bridge serves plain HTTP over the LAN by design, so on
a phone `SpeechRecognition` exists while `navigator.mediaDevices` does not — a
button that can be pressed and can never work. Phone keyboards have their own
microphone key, which belongs to the operating system and works on any origin.

## One non-ACP message: `prompt_draft`

The prompt bar mirrors what is being typed on the phone, live, before it is
sent. Nothing in ACP carries that - it is a property of having two clients
attached to one session - so it is a bridge-level message, relayed to the other
clients and deliberately excluded from the replay history. It never reaches the
agent.

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

## What is checked, and how

| Suite                                       | Covers                                                 |
| ------------------------------------------- | ------------------------------------------------------ |
| `pnpm --filter @couchmode/bridge check:hub` | pairing, replay, reconnect, the draft relay            |
| `pnpm --filter @couchmode/web check:render` | every fixture update through the view-model            |
| `pnpm check:tv`                             | `/tv` and `/phone` in headless Chrome, arrow keys only |
| `apps/tv-shell/scripts/ftv-check.sh`        | a real Fire TV, driven with real remote key events     |

The browser and device suites drive the same code paths a person does: they
press keys and read the DOM, rather than calling functions directly.
