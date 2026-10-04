# Codex runtime fixtures

Captured from the real Codex CLI so the Codex provider's tests replay what Codex
actually sends, not what its documentation implies.

## Provenance (`0.160.0/`)

- **Runtime:** `codex-cli 0.160.0` (`@openai/codex@0.160.0` from npm, `linux-x64`),
  `multi_agent_v2` enabled for the subagent scenario.
- **Captured:** 2026-10-04, in a throwaway `CODEX_HOME` whose `config.toml` points
  at a local mock of the Responses API (`capture/mock-responses.mjs`), so every
  model turn, tool call and token count is scripted (`capture/scenarios.mjs`).
  Token numbers come from the mock, not a real model.
- **Hooks:** a `hooks.json` registering `capture/hook-logger.mjs` for all 12
  events VDP installs. They ran with `--dangerously-bypass-hook-trust`, used
  only in that throwaway home; real installs are trusted with `/hooks`.
- **Sanitized:** with `capture/sanitize.mjs`. Capture paths were replaced with
  `/home/me/...` and strings longer than 160 characters (instructions, prompts)
  with `[trimmed]`. Record order and every other field are as written.

| File                     | Run                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks-overlap.jsonl`    | `codex exec --enable multi_agent_v2 "scenario-a"`: two parallel commands finishing out of order, `apply_patch`, then two subagents (`collaborationspawn_agent`); the root `Stop` arrives while a subagent tool still runs. |
| `hooks-permission.jsonl` | `codex exec --approve-for-me "scenario-b"`: an escalated command raises `PermissionRequest` (no `tool_use_id`) beside a plain command; the rejected command never gets `PostToolUse`.                                      |
| `hooks-resume.jsonl`     | `codex exec -m gpt-5.6-sol resume <id> "second turn"` on the `hooks-overlap` session: compaction events before `SessionStart` (`resume`, then `compact`), and a turn whose tools never complete.                           |
| `rollout.jsonl`          | The root rollout of that session after both runs: `session_meta`, a `turn_context` per turn (model switch), and cumulative `token_count` snapshots (7, 21, 42, 77, 77, 84, 84, 98, 119, 147, 182).                         |

Each `hooks-*.jsonl` line is `{ "event": <Codex event name>, "payload": <stdin JSON> }`,
in the order the hooks ran.

## Re-capturing

With the scripts in `capture/`: start `node mock-responses.mjs scenarios.mjs requests.log`,
point a fresh `CODEX_HOME` at it (`model_provider` with
`base_url = "http://127.0.0.1:8765/v1"`, `wire_api = "responses"`), register
`node hook-logger.mjs <Event> <log>` for every event, run the commands above from
a scratch git repo, then sanitize the logs and the root rollout into a new
`<version>/` directory.
