# Mee JARVIS

Windows Electron app: a Thai voice HUD that drives the Claude Code CLI
(`claude -p --input-format stream-json`). JARVIS does not write code itself;
it streams the user's (spoken) messages to Claude Code and shows the results.
Overview and architecture: README.md. History and measurements: PROGRESS.md.

## Commands

```
npm run check      # node --check on every .js/.mjs (ES modules checked as .mjs copies)
npm test           # node --test "test/*.test.js" — unit + integration with a fake CLI
npm start          # run the app (or `jarvis <folder>` after npm link)
node scripts/integration-real.js   # end-to-end with the real Claude Code; uses a little quota
```

Run `npm run check` and `npm test` after every change, and report the result as it is.
A running app does not pick up changes until it is restarted.

## Layout

- `main.js`: Electron main process. Every IPC channel is registered with `handle()` and
  validates its payload with `lib/ipc-validate.js`.
- `preload.js`: the renderer may only use channels listed in `INVOKE` / `EVENTS`.
  A new IPC channel needs an entry here and a `handle()` in main.js.
- `lib/jarvis-core.js`: the core (Claude session, permission broker, blocks/TTS pipeline,
  audit log). It runs without Electron and talks to the UI only through `ui(channel, payload)`.
  Tests build it directly.
- `lib/claude/`: CLI args, process/session, stream-json parser.
- `lib/permissions/safe.js`: actions approved without asking (`autoApproveSafe`).
  `lib/hooks/guard.js`: the PreToolUse guard (blocks or always asks).
- `lib/coding/project-tools.js`: local voice commands for test, check, diff, and undo
  (git snapshot before each turn).
- `lib/settings.js`: every setting needs a default in `defaults()` and a rule in `SPEC`.
- `lib/prompt.js`: system prompt, teach mode, and coding mode. Mode prompts are sent as a prefix on
  the next message, because the CLI keeps the system prompt per conversation.
- `lib/stt/`, `lib/tts/`: speech in and out. `lib/blocks/`: ```` ```jarvis-* ```` display blocks.
- `renderer/`: sandboxed page served from `app://jarvis/` under CSP, as ES modules with no bundler.
  `renderer/handsfree/commands.js` holds the local voice commands (pure module, matched on
  "folded" Thai text that ignores tone marks).

## Conventions

- UI text, spoken text and prompts are in Thai. Code comments are in English, short and plain.
- Keep modules pure where possible (no DOM / no Electron) so `node --test` can cover them;
  ES modules under `renderer/` are imported from tests with `await import(...)`.
- Security matters here: renderer input is untrusted, never interpolate user/voice text into
  shell commands, never persist `bypassPermissions`, never auto-approve writes to `.git`,
  `.claude` or `.jarvis`.
- Windows first: paths with `path`, spawn with `windowsHide: true`, kill trees with `taskkill /T`.
