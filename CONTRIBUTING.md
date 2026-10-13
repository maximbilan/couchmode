# Contributing

Thanks for taking a look.

## Setup

Node 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm check        # typecheck + replay the fixture through the renderer
pnpm check:tv     # drive /tv in headless Chrome with arrow keys (needs Chrome)
pnpm lint
```

`pnpm check:tv` runs the 10-foot UI against both fixtures in a real browser at
1920×1080, using only the keys a Fire TV remote has. It writes screenshots to
`packages/web/.tv-check/`. It skips itself when Chrome is not installed; set
`CHROME_BIN` to point at another Chromium build.

With a Fire TV on the same network there is a hardware equivalent, which drives
the device with real Android key events and observes the page over the WebView's
devtools socket:

```sh
node packages/bridge/dist/cli.js --fake --code 246810 --port 7777 &
TV_IP=192.168.1.35 apps/tv-shell/scripts/ftv-check.sh
```

It covers what browser key injection cannot: that the shell forwards the remote
into the WebView, that hardware BACK answers a permission request instead of
leaving the app, and that a prompt typed on the TV can be submitted at all.

## Working without an agent

Almost all UI work should happen against the recorded fixture, so you are not
spending tokens to move a button:

```sh
node packages/bridge/dist/cli.js --fake --code 123456
```

To capture a new fixture from a real run:

```sh
node packages/bridge/dist/cli.js --agent claude --record packages/bridge/fixtures/my-run.jsonl
node packages/bridge/scripts/verify-fixture.mjs packages/bridge/fixtures/my-run.jsonl <replay.jsonl>
```

Recordings scrub the project directory to `/project`, the home directory to
`/home/user`, and drop authentication traffic. Read a fixture before committing
it anyway.

There is one hand-written fixture,
`packages/bridge/fixtures/synthetic-plan-and-thoughts.jsonl`. It carries a
`"synthetic": true` header so nobody mistakes it for a recording, and exists
because the real Claude run happens to contain no `plan` or
`agent_thought_chunk` updates — without it those two render paths would ship
untested. Prefer a real recording whenever one can produce the updates you need.

## Ground rules

- **Don't invent protocol.** Couchmode implements ACP. If something is not in
  the spec, it goes in the bridge's own small message layer
  (`packages/bridge/src/protocol.ts`), not into an ACP payload. Quote the spec
  in a comment where you rely on it.
- **Never touch credentials.** Couchmode does not read, store, log, or forward
  them, and nothing auth-related is sent to a client.
- Conventional commits.
- `pnpm lint` and `pnpm check` pass before a PR. CI runs both.
- New ACP `session/update` handling gets a row in
  [`docs/acp-on-tv.md`](docs/acp-on-tv.md) — including types you decide to
  ignore, with the reason.
