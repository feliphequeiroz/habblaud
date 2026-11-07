# PR: add DeepSeek Harness (provider `dsh`)

## Summary

Adds **DeepSeek Harness (DSH)** as a first-class agent provider in Habblaud:

- `dsh` provider with its own account, badge and colour;
- `POST /api/dsh/events` for the local bridge;
- agent source with activity, status, title and token usage;
- read-only terminal built from a JSONL mirror of the DSH session;
- inbound messages through a Cordis plugin that polls `/api/mod/inbox`;
- `npm run dsh:bridge` to tail open DSH sessions.

Everything is local and reads session data only. No credentials, no network calls.

## Motivation

Habblaud already covers Claude Code and Codex. DSH is another agent people run locally, but it stores sessions as
zstd-compressed JSONL and has no hook system like Codex. The integration reuses the existing Office/SourceSet model and
adds a small event route, so the rest of the UI, permissions, timeline and day stats keep working unchanged.

## What changed

### Server

- `shared/types.ts`: `Provider` gains `'dsh'`; `AccountUsage` gains `source: 'dsh'` and `tokens` (session, 5 h, 7 d).
- `server/sources/dsh/source.ts`: event-only source. Creates/updates the main agent, applies activities, publishes
  token usage and exposes `transcriptPathOf`/`terminalParser`.
- `server/sources/dsh/terminal.ts`: maps DSH events (`user/message`, `assistant/message`, `tool/call`, `tool/result`,
  approvals, turn errors) to `TerminalEntry`.
- `server/dsh/http.ts`: `POST /api/dsh/events`, local-only like the Codex hook route.
- `server/index.ts`, `server/http/app.ts`: wire the source, route and `dshEvents` health flag.
- `server/accounts/detect.ts`: completes the alias map for the new provider.
- Terminal mirror: `<dataDir>/dsh/<session>.jsonl` (the original zstd log is never modified).

### Client

- DSH badge, account chip, history/usage/terminal labels and a11y text.
- DSH card shows **tokens** instead of Claude Code percentage windows, and hides the `mod:install`/`/usage` steps.
- Composer hint for DSH (messages work once the plugin is loaded).
- Translations for PT-BR, EN, ES and FR.

### Bridge and plugin

- `scripts/dsh-bridge.ts` (`npm run dsh:bridge`): discovers open sessions through `session.lock`/`lsof`, tails the
  zstd log, posts events, replays after a Habblaud restart (`bootAt`) and closes the agent on `session/end`.
- `mod/habblaud-dsh-inbox/plugin.mjs`: Cordis plugin loaded by the DSH profile; polls `/api/mod/inbox`, calls
  `sessionController.prompt` and acks.

## How tested

- `npm run typecheck` — client and server.
- `npm run build` — Vite + esbuild.
- `npm test` — 1881 passing; one pre-existing failure in `server/world/uplink.test.ts` also fails on a clean `HEAD`.
- `npm run i18n:check` — 3003/3003 in EN/ES/FR.
- Manual: agent appears, activity updates, token card updates, terminal streams `init`/`append`, message sent from
  Habblaud arrives in the DSH session and is acked.
- The patch applies cleanly to a fresh worktree and typechecks there.

## Screenshots

- `docs/community/habblaud-dsh.png`
- `docs/community/habblaud-dsh-usage.png`
- `docs/community/habblaud-dsh-terminal.png`

## Compatibility

- `Provider` is additive: existing Claude/Codex payloads are unchanged.
- World uplink skips `dsh` agents until the World protocol supports the provider (it currently knows Claude and Codex).
- No new runtime dependencies; `zstd` and `lsof` are host tools used by the bridge.

## Limitations / next steps

- Text messages only; no attachments.
- Approvals are shown but answered in the DSH terminal.
- The DSH bridge is a separate process; a future version could use a DSH plugin for events too.
- Upstream World support needs a protocol addition (`provider: 'dsh'`), which is out of scope here.

## Checklist

- [x] Additive protocol change
- [x] Local-only routes and guards
- [x] Typecheck/build/tests
- [x] i18n
- [x] Docs
- [x] Screenshots
