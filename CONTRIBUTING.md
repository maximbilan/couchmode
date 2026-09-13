# Contributing

Thanks for taking a look.

## Setup

Node 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm check        # typecheck + replay the fixture through the renderer
pnpm lint
```

## Working without an agent

Almost all UI work should happen against the recorded fixture, so you are not
spending tokens to move a button:

```sh
node packages/bridge/dist/cli.js --fake --code 123456
```

To capture a new fixture from a real run:

```sh
node packages/bridge/dist/cli.js --agent claude --record fixtures/my-run.jsonl
node packages/bridge/scripts/verify-fixture.mjs fixtures/my-run.jsonl <replay.jsonl>
```

Recordings scrub the project directory to `/project`, the home directory to
`/home/user`, and drop authentication traffic. Read a fixture before committing
it anyway.

## Ground rules

- **Don't invent protocol.** Couchmode implements ACP. If something is not in
  the spec, it goes in the bridge's own small message layer
  (`packages/bridge/src/protocol.ts`), not into an ACP payload. Quote the spec
  in a comment where you rely on it.
- **Never touch credentials.** Couchmode does not read, store, log, or forward
  them, and nothing auth-related is sent to a client.
- Conventional commits.
- `pnpm lint` and `pnpm typecheck` pass before a PR.
- New ACP `session/update` handling gets a row in
  [`docs/acp-on-tv.md`](docs/acp-on-tv.md) — including types you decide to
  ignore, with the reason.
