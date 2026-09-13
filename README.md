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

## Fire TV setup

Lands in M3.

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
| Codex  | `npx -y @agentclientprotocol/codex-acp`        | ⚪ untested                           |
| Gemini | `gemini --experimental-acp`                    | ⚪ untested                           |
| Kiro   | `kiro-cli acp`                                 | ⚪ untested                           |

Codex, Gemini and Kiro are configured but have not been run yet; they are
verified in M4.

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
- [ ] **M2** — `/tv` 10-foot UI: focus manager, permission modal, diff panel
- [ ] **M3** — Fire TV shell (Kotlin WebView), remote control, Back handling
- [ ] **M4** — real projects, Codex/Gemini/Kiro verified, reconnect, voice
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
