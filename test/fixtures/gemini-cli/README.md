# Gemini CLI runtime fixtures

Captured from the real Gemini CLI so the Gemini CLI provider is built and tested
against what Gemini actually does, not what its documentation implies. This is
the runtime gate for the provider: the results below decide the contract that
`src/provider/gemini-cli-*.ts` implements.

## Provenance (`0.62.0/`)

- **Runtime:** `gemini 0.62.0` (`@google/gemini-cli@0.62.0` from npm, the
  `latest` tag on 2026-10-04), `linux-x64`, Node 22.22.0.
- **Captured:** 2026-10-04, in a throwaway `GEMINI_CLI_HOME`, so user settings
  live at `$GEMINI_CLI_HOME/.gemini/settings.json`. Auth is
  `security.auth.selectedType: "gemini-api-key"` with a fake `GEMINI_API_KEY`,
  and `GOOGLE_GEMINI_BASE_URL` points at a local mock of the Gemini API
  (`capture/mock-gemini.mjs`), so every model turn and tool call is scripted
  (`capture/scenarios.mjs`). Token numbers come from the mock (7 × request
  number), not a real model. Model names are what Gemini requested or recorded.
- **Hooks:** user-level `hooks` registering `capture/hook-logger.mjs` for all 11
  Gemini hook events (not just the 7 VDP installs, to show ordering), each with
  `timeout: 3000` and printing the neutral `{}`. The work directory was trusted
  in `trustedFolders.json`, as a real user's project would be.
- **Sanitized:** with `capture/sanitize.mjs`. Capture paths were replaced with
  `/home/me/...` and strings longer than 160 characters (session context,
  prompts) with `[trimmed]`. Record order and every other field are as written.

| File                           | Run                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `help.txt`                     | `gemini --help`: lists the `gemini hooks` command that detection probes for.                                                                     |
| `hooks-overlap.jsonl`          | `gemini -p "scenario-a" --approval-mode yolo`: a slow command and a file read in one response, then a write.                                     |
| `hooks-out-of-order.jsonl`     | The same scenario, rerun until the command started first: the read finishes before it (`BeforeTool` ×2, then `AfterTool` in the opposite order). |
| `hooks-permission.jsonl`       | Interactive `gemini -i "scenario-b"` in tmux: `touch` needs approval (approved with Enter), then `/clear`, then `/quit`.                         |
| `hooks-resume.jsonl`           | `gemini -r <id> -m gemini-3-flash -p "second turn"` on the `hooks-overlap` session, in the same minute.                                          |
| `hooks-resume-later.jsonl`     | `gemini -r <id> -p "third turn"`, a minute later: `SessionStart` names a new, short-lived transcript file.                                       |
| `transcript.jsonl`             | The `hooks-overlap` session's transcript after both resumes.                                                                                     |
| `transcript-resume-stub.jsonl` | The short-lived file the later resume's `SessionStart` named.                                                                                    |
| `transcript-permission.jsonl`  | The `hooks-permission` session's transcript (before `/clear`).                                                                                   |

Each `hooks-*.jsonl` line is `{ "event": <Gemini event name>, "payload": <stdin JSON> }`,
in the order the hooks ran. `test/gemini-cli-contract.test.ts` pins the facts
below to these files; `test/gemini-cli-transcript.test.ts` replays the transcripts.

## Results

| Check                   | Result on 0.62.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version and capability  | `gemini --version` prints `0.62.0`; `gemini --help` lists `gemini hooks <command>`. Each probe takes about 2 s (Gemini relaunches itself).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| User settings shape     | `~/.gemini/settings.json` (`$GEMINI_CLI_HOME/.gemini/` when set), read with comments stripped. `hooks` maps an event name to `[{ matcher?, sequential?, hooks: [{ type: "command", name, command, timeout }] }]`; hook arrays from every settings scope are concatenated. `hooksConfig.enabled` (default `true`) switches the whole hook system; `hooksConfig.disabled` lists hook names to skip; `hooksConfig.notifications` (default `true`) shows "Executing Hooks: <name>" in the UI while hooks run.                                                                                                                       |
| Required events         | `SessionStart` (`source`: `startup`, `resume`, `clear`), `SessionEnd` (`reason`: `exit`, `clear`), `BeforeAgent` (`prompt`), `AfterAgent` (`prompt`, `prompt_response`, `stop_hook_active`), `BeforeTool` (`tool_name`, `tool_input`), `AfterTool` (adds `tool_response`) and `Notification` (`notification_type`, `message`, `details`) all fire. Every payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `timestamp`.                                                                                                                                                                             |
| Hook ordering           | `SessionStart`, `BeforeAgent`, then per tool `BeforeTool` … `AfterTool`, then `AfterAgent`. Tools from one model response run in parallel: both `BeforeTool` hooks fire before either `AfterTool`, completion order can differ from start order, and no payload carries a call id. `PreCompress` (`trigger: "auto"`) and the three model hooks fire before every model request, which is why VDP does not install them.                                                                                                                                                                                                         |
| Permission              | Interactive only. `Notification` with `notification_type: "ToolPermission"` (`details.type`: `exec` for shell) fires after the tool's `BeforeTool` and before its `AfterTool`. Headless `default` mode does not offer tools that need approval, and `yolo` approves without notifying.                                                                                                                                                                                                                                                                                                                                          |
| `/clear` and exit       | `/clear` fires `SessionEnd` (`clear`) for the old id, then `SessionStart` (`clear`) with a **new** `session_id`. `/quit` delivered `SessionEnd` (`exit`) three times for the same session, so ending must be idempotent.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SessionEnd` delivery   | Best-effort. It runs during Gemini's exit cleanup and is awaited on a normal exit (headless and `/quit`). A SIGHUP from closing the terminal delivered it once and lost it once, and SIGKILL never delivers it. Heartbeat-based stale-marker cleanup stays necessary.                                                                                                                                                                                                                                                                                                                                                           |
| Timeout units           | Milliseconds (`DEFAULT_HOOK_TIMEOUT = 60000`). A hook with `timeout: 500` that sleeps 2 s is killed: "Hook timed out after 500ms", and the event finished in 585 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Neutral output          | Printing `{}` and exiting 0 has no effect on Gemini. Gemini parses stdout, or **stderr when stdout is empty**: plain text on exit 0 becomes a `systemMessage`, exit 1 is a non-blocking failure whose stderr is shown to the user ("Warning: <stderr>"), and exit 2 is a blocking `deny`.                                                                                                                                                                                                                                                                                                                                       |
| Fail-open               | A timed-out hook and a crashing hook (exit 1) both let the turn finish normally. Hooks for one event run in parallel unless a group sets `sequential: true`. VDP hooks must still print `{}`, exit 0 and keep stderr empty, or users see warnings.                                                                                                                                                                                                                                                                                                                                                                              |
| Folder trust            | Hooks run only in trusted folders, user-level hooks included: after choosing "Don't trust", a full interactive turn fired no hook at all. Headless runs refuse an untrusted folder outright. Gemini presence is therefore absent in untrusted folders, and VDP must not bypass trust (`--skip-trust`, `GEMINI_CLI_TRUST_WORKSPACE`, `trustedFolders.json`).                                                                                                                                                                                                                                                                     |
| Command execution       | Gemini substitutes `$GEMINI_PROJECT_DIR`, `$GEMINI_CWD`, `$GEMINI_PLANS_DIR`, `$GEMINI_SESSION_ID` and `$CLAUDE_PROJECT_DIR` in the command text, then runs it with `bash -c` on Linux and macOS. On Windows it uses `pwsh -NoProfile -Command`, or `powershell.exe -NoProfile -NonInteractive -Command` (also when `ComSpec` names PowerShell), with `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` appended. The payload arrives on stdin and the hook's cwd is the session `cwd`.                                                                                                                                       |
| Windows command quoting | `capture/command-quoting.mjs`, run under PowerShell 7.5.3 for Linux and under bash, executes a hook command exactly as above for seven install paths. The shared form `node "<entry>" hook …` works for spaces, `'`, `(x86)` and `&;`, but **fails for a path containing `$` or a backtick** in both shells (bash exits 2 on a backtick, which Gemini treats as `deny`). A single-quoted path passes every case: PowerShell `'…'` with `'` doubled, POSIX `'…'` with `'` written as `'\''`. The Gemini provider must quote per shell. Not run on Windows itself, so `.cmd` shims and `node` resolution there remain unverified. |
| Transcript format       | `transcript_path` is `~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`, append-only JSONL. The first record is the metadata `{ sessionId, projectHash, startTime, lastUpdated, kind }`. Then come messages `{ id, timestamp, type, content, … }`, where `type: "gemini"` adds `model` and `tokens` (`input`, `output`, `cached`, `thoughts`, `tool`, `total`), plus `{ $set: {…} }` metadata updates and `{ $rewindTo: <id> }` rewinds. Gemini re-appends a message under the same `id` when it changes (tokens arrive, tool calls are added).                                                             |
| Token fold              | Output tokens are the sum, over unique Gemini message ids, of the latest recorded `tokens.output`: 532 for `transcript.jsonl`. Summing every record would give 833. On resume, `$set.messages` restates the whole history but drops the `tokens` and `model` of messages written before the resume, so Gemini's own loader (which replaces history on `$set.messages`) would keep only 238. A record without tokens therefore never erases a recorded count.                                                                                                                                                                    |
| Model selection         | The latest Gemini message's `model`, as resolved by Gemini: `-m gemini-3-flash` was recorded as `gemini-3.8-flash`, and the next turn switched back to `gemini-3.1-pro-preview`. Routing side calls (`gemini-3.5-flash-lite`) are never recorded.                                                                                                                                                                                                                                                                                                                                                                               |
| Incomplete and unknown  | Gemini appends whole lines (`appendFileSync`), but a reader can still see a partial last line, so it waits for the newline. Unknown records and malformed lines are skipped. A file that does not open with the metadata record is an unknown schema (older Gemini CLI versions wrote one pretty-printed `.json` document) and yields no facts. A compatible hook contract stays `ready` either way.                                                                                                                                                                                                                            |
| Transcript lifetime     | On resume in a later minute, `SessionStart` names a new file holding only metadata and a restatement; every later event names the session's original transcript again. A later Gemini startup deleted both files of that resumed session, and Gemini rewrites an unreadable session file through a temp file and a rename. Readers must tolerate a missing or replaced file. Subagent transcripts live in a separate `chats/<parent-id>/` directory and are not in the root transcript.                                                                                                                                         |

### What this means for the provider

- **Detection** (`src/provider/gemini-cli-detect.ts`): `absent` without a
  `gemini` executable. `unsupported`, with no configuration write, when
  `gemini --help` cannot run, lists no `gemini hooks` command, or the user
  settings set `hooksConfig.enabled: false`. Otherwise `ready`, with the version.
- **Enrichment** (`src/provider/gemini-cli-transcript.ts`): model and output
  tokens only from a transcript that opens with the 0.62.0 metadata record,
  folded as above. Anything else yields no facts, never zero.
- **For the provider ticket:** install `timeout: 3000` hooks at user scope, with
  the entry path single-quoted for the platform's shell. Print `{}`, exit 0 and
  write nothing to stderr. Track tool families with counters, because tools
  overlap and no call id exists. Treat `ToolPermission` as a wait that the
  tool's `AfterTool` ends. Make `SessionEnd` idempotent, and handle `/clear`'s
  new session id. Update the enrichment reference from every event, not just
  `SessionStart`. Tell users in install output that Gemini runs hooks only in
  trusted folders. Gemini accepts comments in `settings.json`, which the strict
  JSON settings writer will refuse to edit rather than rewrite.

## Re-capturing

With the scripts in `capture/`:

1. Install the target version (`npm i @google/gemini-cli@<version>`) and start
   `node mock-gemini.mjs scenarios.mjs requests.log` (listens on `127.0.0.1:8766`).
2. Make a fresh `GEMINI_CLI_HOME`. Write `.gemini/settings.json` with
   `security.auth.selectedType: "gemini-api-key"`, and a `hooks` entry per event
   running `node hook-logger.mjs <Event> <log>` with `timeout: 3000`. Mark a
   scratch git repo as `TRUST_FOLDER` in `.gemini/trustedFolders.json`.
3. From that repo, with `GEMINI_API_KEY=fake` and
   `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8766`, run the commands in the table
   above. Drive the interactive one in `tmux` (`send-keys` Enter to approve,
   then `/clear` and `/quit`). Copy each transcript right after its run, before
   a later startup can delete it.
4. For the timeout check, add a second `BeforeAgent` hook running
   `hook-logger.mjs … 2000` (sleeps 2 s) with `timeout: 500` and run with `--debug`.
5. Run `node command-quoting.mjs <pwsh> <scratch dir>`, with PowerShell for your
   platform, to re-check command quoting.
6. Sanitize with `P=<capture dir> node sanitize.mjs <src> <dst> <hooks|transcript>`
   into a new `<version>/` directory and update the tests' fixture paths.
