# Couchmode

**Your coding agent, in couch mode.** The [Agent Client Protocol](https://agentclientprotocol.com)
client for the living room.

Zed and JetBrains are ACP clients for the desk. Couchmode is the one for the
couch: your agent runs on your laptop against a real project, a Fire TV shows
what it is doing in large readable form, and you approve or reject its tool
calls with the remote.

> _screenshot / GIF placeholder — added in M3_

## Why this exists

Coding agents spend a lot of their time waiting for a human to say yes. That
moment does not need a keyboard, a terminal, or even a desk. It needs a big
clear description of what is about to happen and two buttons. That is a TV.

Couchmode does not invent a protocol. It implements ACP and documents how each
concept maps to a 10-foot UI — see [`docs/acp-on-tv.md`](docs/acp-on-tv.md).

## Run in 60 seconds

No TV needed — your phone or a second browser tab is enough.

```sh
git clone https://github.com/<you>/couchmode && cd couchmode
pnpm install && pnpm build

cd ~/some/project
node /path/to/couchmode/packages/bridge/dist/cli.js --agent claude
```

The terminal prints a 6-digit pair code and a LAN URL. Open
`http://<your-ip>:7777/phone` on your phone, type the code, and ask the agent
for something. When it wants to edit a file or run a command, the approval
lands on your phone.

Requires **Node 22+** (the Claude adapter requires it) and `pnpm`.

### Try it without spending tokens

Couchmode ships a recording of a real Claude session and can replay it as a
live ACP agent:

```sh
node packages/bridge/dist/cli.js --fake
```

The replay includes two permission requests and a file diff, and blocks until
you actually submit a prompt — the bridge's ACP code path is identical to a
live run.

Open `http://localhost:7777/tv` in a browser at 1920×1080 to drive the 10-foot
UI with the arrow keys, Enter and Escape — exactly the buttons a Fire TV remote
has. Nothing in `/tv` needs a pointer.

## The TV UI

`/tv` is designed for 1920×1080 viewed from about three metres: body text 28px,
controls at least 64px tall, and a bright 3px focus ring. Focus moves
spatially — there is no tab order, because a remote has no Tab key.

| Button  | What it does                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------- |
| ▲ ▼ ◀ ▶ | move focus, or scroll the panel you are in — a page at a time, faster while held               |
| OK      | activate; on the prompt bar it opens a text field; on Activity it expands the agent's thinking |
| Back    | close what is open, answer a permission request with its deny option, or jump to the latest    |
| MENU    | switch agents (long press opens the Fire TV shell's own settings form)                         |

The **Changes** panel only appears once the agent has actually changed a file.
Until then the activity feed has the screen to itself, rather than half of it
being spent on an empty box.

### Getting out of a long conversation

An hour-old transcript is taller than the screen many times over, and ▼ scrolls
the feed rather than leaving it — so on a naive design the prompt bar recedes as
the conversation grows, and while the agent is streaming it can recede faster
than you can scroll.

Three things keep that bounded. A press moves most of a page rather than a fixed
sliver; holding the button accelerates; and **Back always returns to the
present** in one press, whatever you were reading. The prompt bar is then one ▼
away — two presses from anywhere, however long the conversation.

While you are scrolled up, the feed says so: a chip counts what has arrived
since and names the button that catches you up. What is on screen is no longer
live, and a 10-foot UI should never leave that ambiguous.

### Knowing whether it is connected

The top bar states the link in words — **Connected**, **Reconnecting…**,
**Disconnected · retrying in 4s** — because at three metres a small green dot
and a small grey one are the same dot. While the link is down the agent's status
is dimmed: "Thinking" describes what was true before the drop, not now.

Couchmode notices a link that has gone quiet as well as one that has closed. A
TV that sleeps, or an access point that hands the client to another radio,
leaves a socket the browser still calls open and the bridge never hears from
again; a 15-second application-level ping is the only thing that catches it.

Reconnecting re-pairs, and pairing replays the session so far, so the transcript
is rebuilt rather than appended to — reconnect as often as you like and nothing
is duplicated. The feed marks where it caught up.

### Switching agents

Focus the agent's name in the top bar, or press **MENU**, to switch agents
without restarting the bridge. The picker names the command each agent would
actually run, because four rows that all say "CLI" are not a choice.

Switching ends the ACP session — a session belongs to the agent that created it
— so the transcript and any pending approvals are cleared, and the picker says
so before you choose. The new session announces itself: the top bar shows the
incoming agent as it starts, a rule across the feed says which agent the session
belongs to and what it replaced, and a banner confirms when it is ready to take
a prompt. Choosing the agent that is already running restarts it, which is what
you want when one has wedged.

When the agent asks permission, a modal takes focus and shows the agent's own
options in the order it gave them. See
[`docs/acp-on-tv.md`](docs/acp-on-tv.md#which-button-the-remote-starts-on) for
which button the remote starts on and why.

## Fire TV setup

Verified on a Fire TV Stick running **Fire OS 8.1.8.2** (Android 11, API 30).

Enable ADB debugging on the device — _Settings → My Fire TV → Developer
Options → ADB debugging_ — then:

```sh
TV_IP=192.168.1.35 scripts/install-tv.sh
```

The TV asks for the address and pair code the bridge printed, remembers them,
and goes straight to `/tv` on every launch after that. Press and hold **MENU**
to change them.

The shell is deliberately thin: a fullscreen WebView and a settings form, with
no dependencies at all. Everything you see on screen is the web client the
bridge serves, so improving the TV experience means editing TypeScript, not
reinstalling an APK.

Two Fire OS behaviours worth knowing as a user:

- **Back** closes whatever is open — the composer, or a permission request
  (answering it with its deny option) — then catches the feed up to the latest
  activity. It only leaves the app when there is nothing left to do.
- While the on-screen keyboard is up, **Back is how you send a prompt**. Fire OS
  commits the text when the keyboard closes. There is also a Send button.

If the bridge is not running when the app starts — or it goes away while the TV
is on — the shell says so, counts down, and keeps retrying by itself until the
page loads. Reopening a laptop lid in another room is enough; nothing needs
pressing on the TV.

**MENU** is two buttons in one: a short press opens the agent picker, a long
press opens the shell's own settings form. The shell swallows the key either way
so Fire OS cannot pop its own menu over the app, and hands the short press to
the page the same way it hands over Back.

The full friction log, including the two bugs this shook out, is in
[`docs/firetv-notes.md`](docs/firetv-notes.md).

## How it works

```
 ┌─────────────────────────────┐         ┌──────────────────┐
 │        your machine         │         │     Fire TV      │
 │                             │         │                  │
 │  agent CLI  ◄──stdio───►    │         │  ┌────────────┐  │
 │  (claude,      JSON-RPC     │         │  │  WebView   │  │
 │   codex, …)        │        │   LAN   │  │    /tv     │  │
 │                    ▼        │◄───────►│  └────────────┘  │
 │            couchmode bridge │ WebSocket└──────────────────┘
 │            (the ACP client) │         ┌──────────────────┐
 │                             │◄───────►│  phone  /phone   │
 └─────────────────────────────┘         └──────────────────┘
```

The bridge is the ACP client. It owns the session, answers the agent's
filesystem and permission requests, and forwards every `session/update` to the
TV and phone unchanged. The TV and phone never talk to the agent — only the
machine holding your code can spawn processes and touch files.

Permission requests go to every paired client at once; the first answer wins.

## Supported agents

Agent launch is data, not code: see
[`packages/bridge/src/config/agents.json`](packages/bridge/src/config/agents.json),
overridable at `~/.couchmode/agents.json`.

| Agent  | Command                                        | Status                                |
| ------ | ---------------------------------------------- | ------------------------------------- |
| Claude | `npx -y @agentclientprotocol/claude-agent-acp` | ✅ tested — recorded fixture included |
| Kiro   | `kiro-cli acp`                                 | ✅ tested on Kiro CLI 2.21.4          |
| Codex  | `npx -y @agentclientprotocol/codex-acp`        | ⚪ untested                           |
| Gemini | `gemini --acp --skip-trust`                    | ⚪ untested                           |

Codex and Gemini are configured but have not been run yet.

Claude on Amazon Bedrock or Google Vertex AI needs nothing from Couchmode:
configure it in Claude Code — `CLAUDE_CODE_USE_BEDROCK=1` (or
`CLAUDE_CODE_USE_VERTEX=1`) in your environment or in the `env` block of
`~/.claude/settings.json` — and `--agent claude` inherits it. If an agent sits on "Thinking" forever, check that its cloud credentials
have not expired; see [`docs/upstream-issues.md`](docs/upstream-issues.md).

## Authentication

Couchmode doesn't handle credentials. It runs your agent's CLI, which uses the
login you already have. If a CLI isn't logged in, log in with that CLI first.

Couchmode never asks for, stores, displays, or forwards credentials. It passes
your ambient environment to the agent process and nothing auth-related ever
reaches the TV or phone. If an agent reports that it is not authenticated,
Couchmode prints that agent's own login command from `agents.json` and shows the
agent's error text in the UI. `ANTHROPIC_API_KEY` and friends are optional
pass-throughs, documented in [`.env.example`](.env.example) — never required.

## CLI

```
couchmode [options]

  --agent <name>     agent from agents.json to spawn          (default: claude)
  --port <number>    HTTP + WebSocket port                    (default: 7777)
  --host <addr>      interface to bind                        (default: 0.0.0.0)
  --code <digits>    fixed pair code, for development         (default: random)
  --cwd <path>       project directory for the ACP session    (default: cwd)
  --mode <id>        ACP session mode to request              (default: per agent)
  --web-dev-url <u>  proxy the web client to a Vite dev server
  --fake [file]      replay a recorded session instead of spawning an agent
  --record <file>    record this session to a .jsonl fixture
```

## Roadmap

- [x] **M1** — ACP bridge + phone client, recorded fixture, `--fake` replay
- [x] **M2** — `/tv` 10-foot UI: focus manager, permission modal, diff panel
- [x] **M3** — Fire TV shell (Kotlin WebView), remote control, Back handling
- [x] **M4** — real projects, more agents, agent picker, reconnect, voice
- [ ] **M5** — demo assets

## Documentation

- [ACP on a TV](docs/acp-on-tv.md) — the full protocol-to-UI mapping
- [Fire TV notes](docs/firetv-notes.md) — device friction log
- [Upstream issues](docs/upstream-issues.md) — gaps found in ACP and adapters

## Hackathon

Built for the Amazon _Build, Ship, Shape_ hackathon — Fire TV track and the
Open Source mini challenge.

## License

MIT
