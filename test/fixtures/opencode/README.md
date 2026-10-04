# OpenCode runtime fixtures

Captured from the real OpenCode so the OpenCode provider is built and tested
against what OpenCode actually does, not what its documentation or SDK types
imply. This is the runtime gate for the provider: the results below decide the
contract that `src/provider/opencode-*.ts` implements.

## Provenance

- **Runtime:** `opencode 1.18.34` (`opencode-ai@1.18.34` from npm, the `latest`
  tag on 2026-10-04; source tag `v1.18.34`), `linux-x64`. The npm `opencode`
  command is a launcher that starts the Bun-compiled platform binary
  (`opencode-linux-x64`) as a child process; the plugin runs inside that child,
  under Bun 1.3.14. The sink the plugin starts ran on Node 22.22.0.
- **Boundary runtimes:** `1.0.223` (the last release that emits
  `permission.updated`; 1.0.224 switched to `permission.asked`), and `1.15.10` /
  `1.15.11` (the last release without, and the first with, plugin `dispose`).
  Found by bisecting the release binaries and `@opencode-ai/plugin` types, then
  confirmed by running each binary.
- **Captured:** 2026-10-04, in throwaway homes (`HOME` and every
  `XDG_*_HOME`), so OpenCode's global config directory was
  `$XDG_CONFIG_HOME/opencode`. `opencode.json` there defined one custom provider
  through the bundled `@ai-sdk/openai-compatible` package, pointed at a local
  Chat Completions mock (`capture/mock-openai.mjs`), so every model turn and
  tool call is scripted (`capture/scenarios.mjs`). Token numbers come from the
  mock (7 × request number output tokens); cost comes from the model's
  configured price (`input: 1`, `output: 2` per million). `permission.bash` was
  `ask`. `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_MODELS_FETCH` were
  set. The capture shell exported `BUN_OPTIONS=--smol` (a sandbox default),
  which 1.18.34 ignores but which breaks 1.0.223's argument parsing, so the
  1.0.223 run unset it.
- **Plugin:** `capture/vdp-probe.js`, copied into `<config>/plugins/`, where
  OpenCode auto-discovers it with no entry in any config file. It logs every
  callback in invocation order and runs the delivery design described in its
  header: one ordered queue, one child process in flight, a fixed argv
  (`node sink.mjs <ref>`, no shell), the snapshot on stdin, and a bounded drain
  in `dispose`. Unless the table says otherwise, runs used `VDP_PROBE_BATCH=1`
  (each child takes everything queued, as JSONL) and a 2,000 ms drain. Unknown
  session ids are resolved with `client.session.get`, following `parentID` up
  to 8 levels with cycle protection.
- **Sanitized:** with `capture/sanitize.mjs`. Capture paths were replaced with
  `/home/me/...` (the work repo is `/home/me/my-app`) and strings longer than
  160 characters (system prompts, tool output, file contents) with
  `[trimmed]`. Record order and every other field are as written.

Each `plugin-*.jsonl` line is one probe record:
`{ seq, instance, at, kind, ... }`, where `kind` is `init`, `event` (with the
full `event`), `chat.message`, `tool.execute.before` / `after`,
`permission.ask`, `lookup` (a root resolution), `delivered` (one finished
child: `refs`, `ms`, `code`, `signal`), `dispose` or `dispose.done` (with what
was still `queued` and `inFlight`). `seq` restarts for each plugin `instance`.

| File                                    | Run                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1.18.34/version.txt`                   | `opencode --version`.                                                                                                                                                                                                                                               |
| `1.18.34/debug-paths.txt`               | `opencode debug paths`, which detection reads.                                                                                                                                                                                                                      |
| `1.18.34/plugin-tools.jsonl`            | `opencode run --auto "scenario-tools"`: a slow command and a file read in one response, then a write.                                                                                                                                                               |
| `1.18.34/plugin-permission-tui.jsonl`   | Interactive TUI in tmux, `scenario-permission`: the first command approved with "Allow once", the second rejected, then `/exit`.                                                                                                                                    |
| `1.18.34/plugin-subagent-dispose.jsonl` | `opencode serve`, driven by `capture/drive-serve.mjs subagent-reload`: a `task` subagent whose own command asks for permission; the instance is then disposed (`POST /instance/dispose`), which reloads plugins.                                                    |
| `1.18.34/plugin-unknown-child.jsonl`    | The same server, next: the orphaned child session prompted again, so a fresh plugin instance meets a child it never saw created.                                                                                                                                    |
| `1.18.34/plugin-resume.jsonl`           | A new process, `opencode run --auto -s <root> "scenario-text resumed"` on that root session.                                                                                                                                                                        |
| `1.18.34/plugin-cycle-dangling.jsonl`   | `opencode serve`, prompting two sessions written with `opencode import`: one whose parent is a session that names it as its parent, one whose parent does not exist.                                                                                                |
| `1.18.34/session-get.json`              | `client.session.get` for a root, a child, both cycle members, the dangling child and the missing parent.                                                                                                                                                            |
| `1.18.34/session-messages.json`         | `client.session.messages` for the root: the REST view of per-message usage.                                                                                                                                                                                         |
| `1.18.34/plugin-shutdown-queued.jsonl`  | `scenario-tools` with one child per event (no batching), only session, message, part and permission types queued, each child delayed 120 ms, and an 8,000 ms drain: a backlog at exit.                                                                              |
| `1.18.34/plugin-queue-failures.jsonl`   | `scenario-tools` with one child per event and only `session.status`, `session.idle`, `session.diff` and permission types queued; `session.status` children exit 1 and `session.diff` children hang until the plugin's 3 s child timeout kills them. 5,000 ms drain. |
| `1.18.34/plugin-run-sigterm.jsonl`      | `opencode run --auto "scenario-long"` (a 20 s command), sent SIGTERM as a process group 7 s in. SIGINT and SIGHUP gave the same result.                                                                                                                             |
| `1.18.34/plugin-tui-ctrl-c.jsonl`       | TUI, `scenario-long`, Ctrl+C while its permission prompt is open, then Ctrl+C again.                                                                                                                                                                                |
| `1.18.34/plugin-tui-hangup.jsonl`       | TUI, `scenario-long`, the terminal closed (`tmux kill-session`) while its permission prompt is open.                                                                                                                                                                |
| `1.0.223/plugin-permission.jsonl`       | `opencode serve` 1.0.223, driven by `drive-serve.mjs permissions once reject`.                                                                                                                                                                                      |
| `1.0.223/debug-paths.txt`               | `opencode debug paths` on 1.0.223.                                                                                                                                                                                                                                  |
| `1.15.10/plugin-exit.jsonl`             | `opencode run --dangerously-skip-permissions "scenario-text"` on 1.15.10.                                                                                                                                                                                           |
| `1.15.11/plugin-exit.jsonl`             | The same on 1.15.11.                                                                                                                                                                                                                                                |

`test/opencode-contract.test.ts` pins the facts below to these files, and
`test/opencode-detect.test.ts` covers detection.

## Results

| Check                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                    | `opencode --version` prints `1.18.34` (about 0.7 s). Snapshot channels print `0.0.0-<channel>-<stamp>`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Global plugin discovery    | OpenCode loads every `{plugin,plugins}/*.{js,ts}` in its global config directory, `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`, on Windows too), then in each `.opencode/` up the tree. No config entry is needed. `opencode debug paths` prints that directory as its `config` line, on 1.0.223 as on 1.18.34. `OPENCODE_CONFIG_DIR` adds a directory rather than replacing it, and `--pure` / `OPENCODE_PURE` disable external plugins for that launch. Discovery worked in `run`, `serve` and the TUI.    |
| Config directory contents  | OpenCode itself writes `package.json`, `package-lock.json`, `node_modules/` (it installs `@opencode-ai/plugin`) and a `.gitignore` into that directory. A plugin file there must be self-contained, with Node built-in imports only. Any launch, `--version` included, creates OpenCode's empty data, config, cache and state directories.                                                                                                                                                                             |
| Module shape               | A module either exports `{ server }` or only plugin functions: OpenCode calls every export and rejects the module if one is not a function. A plugin's init runs once per instance, before any event.                                                                                                                                                                                                                                                                                                                  |
| Callback ordering          | `event` is called without being awaited (`void hook.event(...)`), synchronously in bus order, so its order is reliable but its async work interleaves. `tool.execute.before` / `after` and `chat.message` are awaited: a slow plugin there stalls OpenCode. Events are delivered only for the instance's own directory. The `permission.ask` hook never fires on 1.18.34; it fired on 1.0.223.                                                                                                                         |
| Event names                | 1.18.34 sends `session.created`, `session.updated`, `session.status` (`busy`, `idle`, `retry`), `session.idle`, `session.error`, `session.diff`, `message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`, `file.edited` and housekeeping (`plugin.added`, `catalog.updated`, …). It never sends `permission.updated`, which survives only in the v1 SDK types. 1.0.223 sent `permission.updated`.                                                                    |
| Permission payloads        | 1.18.34: `permission.asked` `{ id, sessionID, permission, patterns, metadata, always, tool: { messageID, callID } }` and `permission.replied` `{ sessionID, requestID, reply: "once" \| "always" \| "reject" }`. 1.0.223: `permission.updated` `{ id, type, pattern, sessionID, messageID, callID, title, metadata, time }` and `permission.replied` `{ sessionID, permissionID, response }`. The reply's id and answer fields were renamed too.                                                                       |
| Permission ordering        | The request follows its tool's `tool.execute.before` and can arrive before or after the part turns `running`. Approval: the part runs and completes. Rejection, including Ctrl+C at the TUI prompt: `reply: "reject"`, the part ends in `error`, and `tool.execute.after` never fires. `--auto` still sends `permission.asked`, answered at once with `once`.                                                                                                                                                          |
| Tools                      | Every tool call has a stable `callID`, in the tool hooks and in its `message.part.updated` part (`pending` → `running` → `completed` or `error`). Tools from one response run in parallel and complete in any order: the read finished before the slower command that started first.                                                                                                                                                                                                                                   |
| Subagents                  | A `task` subagent is a child session: `session.created` with `parentID`, and its events carry the child's own `sessionID`. A child's tool can ask for permission under the child's id.                                                                                                                                                                                                                                                                                                                                 |
| Message updates and usage  | `message.updated` repeats for one assistant message: created with zero tokens, then once tokens arrive, then again on completion with the same values. Summing every update overcounts; the latest value per message id is correct. `info` has `modelID`, `providerID`, `tokens.output` and `cost`. `session.updated` carries the session's own aggregate `tokens` and `cost`, equal to the latest values summed per message. A child's usage is not added to its root.                                                |
| Resumed root               | `opencode run -s <id>` in a new process sends no `session.created`: the first session callback is `chat.message`, and only the new turn's messages are reported, not earlier usage. `client.session.get` resolves it as a root, and `session.get` / `session.messages` hold the full usage (REST recovery).                                                                                                                                                                                                            |
| Unknown child              | A plugin instance that never saw a child's `session.created` (here, after a reload) gets the child's events directly. `client.session.get` on the child returned `parentID`, and on the parent none, but only about 480 ms later, after several child events had arrived. Lookups otherwise took 4–64 ms.                                                                                                                                                                                                              |
| Parent cycles and dangling | `opencode import` writes a session's `id` and `parentID` as given, so the store can hold a cycle or a parent that does not exist. `session.get` returns both cycle members (each naming the other); a missing session is a 404 `NotFoundError`. The probe's bounded walk reported `cycle` and `unresolved`.                                                                                                                                                                                                            |
| Delivery cost              | One child per event cost a median 44 ms, so one turn (about 120 events, 45 of them `plugin.added`) outran it: in a smoke run without batching or a type filter, 21 entries were still queued when a 2 s drain ran out. Batching handed up to 35 entries to one child, delivered all 122 events of a turn, and drained in 0.5 s. Order held in every run, per instance.                                                                                                                                                 |
| Fixed argv and stdin       | With `shell: false`, an install path containing spaces, `$HOME`, backticks, both quote styles, `(x86)`, `&;`, `%PATH%` and `!` reached the child byte for byte through OpenCode's Bun `child_process.spawn`, and every snapshot arrived complete on stdin (up to 4.3 KB per child). **Not run on Windows**, where Bun builds a command line for `CreateProcess`; there the child must be an `.exe` (`node.exe`), since a `.cmd` shim needs a shell.                                                                    |
| Failure isolation          | Children that exited 1 and children that hung (killed by the plugin's 3 s timeout) did not stop the queue: later entries were delivered, in order. A hung child costs its timeout, so a short child timeout keeps the drain inside its budget.                                                                                                                                                                                                                                                                         |
| `dispose` at exit          | From 1.15.11, OpenCode awaits every plugin's `dispose` before exiting, after the session's final `idle`. 1.18.34 sets no deadline of its own: a 20 s drain held `opencode run` for 20 s. A child still running at exit survives it (it is reparented), so only entries not yet started are lost. Events keep reaching an instance after its `dispose` starts, and a late event can start a second instance during shutdown that is never disposed.                                                                     |
| Lifecycle ends at shutdown | With an ordered queue and a bounded drain, the `session.status: idle` and `session.idle` events queued at exit were delivered, with no coalescing (37 entries were queued at `dispose`, drained in 7.2 s at 120 ms per child). **1.15.10 never calls `dispose`**: those two idle events were exactly what it lost on a normal exit.                                                                                                                                                                                    |
| Signals                    | `opencode run` sent SIGINT, SIGTERM or SIGHUP as a process group (as a terminal does) dies at once: no `dispose`, no `idle`; the last event was a running tool. SIGKILL is the same. The TUI handles them: closing its terminal sent `session.error` (`MessageAbortedError`), `idle`, then `dispose`; Ctrl+C rejects an open permission prompt (a second press quits). An open permission request ended by abort gets **no** `permission.replied`. Signalling only the launcher's pid leaves the real process running. |
| Instance dispose (reload)  | `POST /instance/dispose` (also how a config change reloads plugins) aborts running work: the child got `session.error`, `idle`, and its pending permission request disappeared (a reply returned 404). The root got no end event before `dispose`. The next request for that directory starts a new plugin instance.                                                                                                                                                                                                   |
| Working directory          | OpenCode takes its project directory from the `PWD` environment variable, not from the process's working directory.                                                                                                                                                                                                                                                                                                                                                                                                    |

### What this means for the provider

- **Detection** (`src/provider/opencode-detect.ts`): `absent` without an
  `opencode` executable. `unsupported`, with nothing written, when
  `opencode --version` gives no release version (snapshot builds included),
  when it gives one before 1.15.11, or when `opencode debug paths` names no
  global config directory. Otherwise `ready`, with the version. Nothing on the
  command line reveals whether `dispose` is awaited, so that boundary is a
  version; the floor also covers the `permission.asked` rename (1.0.224).
- **The provider** (`src/provider/opencode*.ts`, tested by
  `test/opencode*.test.ts`, which replay these fixtures through the generated
  plugin and the hook) follows the points below.
  - Install one self-contained plugin file in `<config>/plugins/`, with the
    config directory taken from `opencode debug paths`, never by editing
    `opencode.json`.
  - Return from every callback at once. Snapshot only what the provider needs,
    into one ordered queue with one child in flight, started with a fixed argv
    (the absolute `node` executable and the VDP entry) and the snapshot on
    stdin. Batch what is queued, or filter out housekeeping types, because one
    child per event cannot keep up.
  - In `dispose`, drain for a bounded time, since OpenCode waits as long as it
    takes, and treat `dispose` as the end of every session that instance
    tracked, since a reload ends a root with no event. Give each child a short
    timeout.
  - Accept `permission.asked` and `permission.updated`, read
    `requestID ?? permissionID` and `reply ?? response`, and also end a wait at
    the session's `idle` or `error`, since an aborted request gets no reply.
  - Track tools by `callID`, from `tool.execute.*` or the tool parts. A
    rejected tool never sends `tool.execute.after`, so its part's `error`
    state, or the turn's `idle`, must end it.
  - Resolve unknown sessions with `client.session.get`, and hold their events
    until the root is known: the answer can arrive after the first events.
    Bound the walk and stop at a cycle or a 404, ignoring the activity rather
    than creating a root.
  - Take model, output tokens and cost from `message.updated`, keeping the
    latest value per message id. `session.updated`'s aggregate, or REST
    `session.messages`, can rebuild earlier usage after a resume.
  - Keep heartbeat-based staleness: `opencode run` killed by a signal, and
    SIGKILL, end with no event at all.

## Re-capturing

With the scripts in `capture/`:

1. Install the target version (`npm i opencode-ai@<version>`; for an old one,
   `npm pack opencode-linux-x64@<version>` gives the platform binary alone) and
   start `WORK=<work dir> node mock-openai.mjs scenarios.mjs requests.log`
   (listens on `127.0.0.1:8767`).
2. Make a throwaway home: set `HOME` and every `XDG_*_HOME` to it. Write
   `$XDG_CONFIG_HOME/opencode/opencode.json` with `"model": "mock/mock-large"`,
   `"small_model"` the same, `"permission": { "bash": "ask" }`, and a `mock`
   provider: `"npm": "@ai-sdk/openai-compatible"`,
   `"options": { "baseURL": "http://127.0.0.1:8767/v1", "apiKey": "fake" }`,
   `"models": { "mock-large": { "cost": { "input": 1, "output": 2 } } }`. Copy
   `vdp-probe.js` into `$XDG_CONFIG_HOME/opencode/plugins/`. Make `<work dir>` a
   git repo with a `README.md`.
3. Set `VDP_PROBE_LOG`, `VDP_PROBE_SINK` (the absolute path of `sink.mjs`),
   `VDP_PROBE_SINK_LOG`, `VDP_PROBE_NODE` (an absolute `node`) and the
   per-run settings in the table (`VDP_PROBE_BATCH`, `VDP_PROBE_FILTER`,
   `VDP_PROBE_DRAIN_MS`, `VDP_PROBE_SINK_DELAY_MS`, `VDP_PROBE_FAIL_TYPES`,
   `VDP_PROBE_HANG_TYPES`, `VDP_PROBE_CHILD_TIMEOUT_MS`), plus
   `OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1`.
4. From `<work dir>` (`cd` into it, so `PWD` matches), run the commands in the
   table. Drive the TUI in `tmux` (`send-keys` Enter to allow once, Right Right
   Enter to reject, `/exit`, `C-c`, `kill-session`). Drive `opencode serve
--port <n>` with `node drive-serve.mjs <sdk dir> http://127.0.0.1:<n> <work
dir> <step>`, using `@opencode-ai/sdk` of the same version. For signals,
   start `opencode` in its own process group and signal the group. For the
   cycle, `opencode export` a session, write two copies whose `parentID`s name
   each other (and one naming a missing session), and `opencode import` them.
5. Sanitize with `P=<capture roots, ':'-separated> node sanitize.mjs <src>
<dst> jsonl` (or `json` for the lookup dumps) into a new `<version>/`
   directory and update the tests' fixture paths.
