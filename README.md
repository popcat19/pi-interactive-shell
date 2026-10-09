# pi-interactive-shell

Approval-gated Linux PTY execution for Pi, with session-owned background tasks. Output is private by default. The extension does not install itself, change Pi settings, publish, contact a network, invoke sudo/doas, or cache credentials.

## Load locally

```sh
cd /home/popcat19/pi-interactive-shell
PI_CODING_AGENT_DIR=/tmp/pi-interactive-shell-settings pi --no-session --no-extensions -e ./src/extension.ts
```

Requires Linux, Python 3, bash, and Pi's interactive TUI with TTY stdin and stdout. Commands appear as exact JSON-escaped text before execution. Review all rendered command pages and press `y` on the last page to approve; navigation invalidates approval until the target page renders, and width changes restart review; Esc denies. Never put credentials in commands or chat.

| Local command | Operation |
|---|---|
| `/shell COMMAND` | Private foreground execution |
| `/shell-bg COMMAND` | Private background task; receipt after approval |
| `/shell-visible COMMAND` | Foreground execution with explicit output-visible approval |
| `/shell-bg-visible COMMAND` | Background execution with explicit output-visible approval |
| `/shell-tasks` | List this session's task IDs, statuses, and policies |
| `/shell-attach ID` | Focus existing task output and masked response input |
| `/shell-stop ID` | Stop the task and await broker cleanup |
| `/shell-release ID START END` | Preview selected private output and approve its release |

`interactive_shell` accepts `command`, optional `timeout`, optional `background` (default false), and optional `output` (`private` by default, or `visible`). Background execution returns an ID immediately after approval, not after command completion. Tool results do not carry private output, command text, or responses. `shell_task` accepts `action` (`list`, `status`, `read`, `stop`) and `id` except for list. Read exposes only output allowed by the task's approved policy. It cannot change policy, release private output, attach a screen, or submit input. No partial tool updates contain output.

Background tasks do not auto-focus or solicit credentials through the model. When a prompt is detected, status becomes `waiting-for-user` and the receipt/status includes `/shell-attach ID`. The user runs that command locally. Prompt expiry returns status to `running`; this does not prove the program stopped waiting. Ctrl+P requests a fresh manual prompt lease when necessary.

Enable the existing agent bash integration only per launch:

```sh
pi --extension ./src/extension.ts --interactive-shell-bash
```

Without that flag, stock `bash` registration is untouched. The replacement registers at `session_start`, requires approval, and always starts with private output.

## Output policies

### Private default

Output is retained only in bounded process memory and the transient local screen. It is absent from tool content, details, updates, error text, session entries, and notifications. Task metadata exposes only ID, coarse status, policy, exit code, and attach command. Negative exit codes indicate signal termination.

To release output, use `/shell-release ID START END` with zero-based character offsets into the currently retained sanitized output; END is exclusive. At most 4096 characters can be selected per approval. Missing or invalid offsets show the current retained character count, not the output. The approval screen displays the exact selected text as JSON-escaped pages. Esc cancels; `y` on the last page releases only that snapshot, even if the running task emits more output during review. This does not enable future sharing. No release-all shortcut exists. `shell_task read` retrieves approved selections, retaining at most the last 4096 released characters. Repeated release calls require separate local approvals.

### Explicit output-visible approval

Requesting `output: "visible"` does not grant permission. The local approval displays the exact command plus an echo-risk warning: programs can echo credentials, including masked responses; all captured output can reach the model and session transcript. No process starts and no output is captured before approval. Policy is immutable for each task. Read never upgrades a private task. Visible reads expose the last 16384 sanitized characters, not a durable or complete log.

Visible mode does not redact secrets. Masked input prevents direct response transport to the model, but an approved command that prints or echoes the response exposes it through visible output. Use private mode for authentication unless this risk is acceptable.

## Controls and lifecycle

- Attached screens retain task ID and output policy; visible tasks keep the credential echo warning on screen.
- `PgUp`/`PgDn` browse 256-character retained-output pages with zero-based `[START, END)` labels and JSON-escaped text. Offsets refer to the current retained buffer and shift as new output arrives; the release approval always previews its own exact snapshot.
- `Ctrl+D` detaches a running screen without stopping its task. Reattach using the receipt ID.
- `Esc` or `Ctrl+C` stops a running task and waits for broker cleanup before returning its receipt. On a completed screen, Esc or Enter closes it.
- `Ctrl+P` requests manual masked input; Enter sends once; Ctrl+U clears provisional text.
- Every run requires local approval. Approval and release screens expire after 60 seconds. Completed screens auto-close after 10 seconds.
- Only one approval/input/release screen is admitted at a time. Competing requests return `busy`, not another screen.
- At most 8 tasks run concurrently. History retains at most 16 tasks, evicting completed tasks first. Completed task output expires after 10 minutes, swept every second. Session shutdown, reload, replacement, and fork clear ownership and retained output.
- Output retains the last 16384 ASCII-sanitized characters per task. Protocol parsing and pending writes are bounded. No log files are created. Released-output retention is separately capped at 4096 characters.
- Default run deadline remains 300 seconds. `--interactive-shell-timeout` accepts 1..3600 seconds; per-call `timeout` uses the same bounds. Background tasks have the same finite deadline and no keepalive extension.
- Prompt leases remain 30 seconds by default. `--interactive-shell-lease` accepts 1..120 seconds. Reattach preserves the remaining lease, not a new deadline.
- Prompt output, termios changes, expiry, submission, stop, and process exit invalidate provisional responses. Generation checks reject stale replies. No retries, credential caching, or secret resubmission occur.
- Stop and orderly Pi shutdown terminate the broker, which terminates the PTY process group and reaps its shell child. A broker watchdog escalates after 1.5 seconds; a run watchdog stops overdue brokers 2 seconds after their deadline. Linux parent-death signaling handles abrupt Pi exit.

Tasks belong to the current in-memory Pi session. There is no durable service manager, restart, reconnect across Pi processes, or daemon support. Descendants that detach into another session/process group are **not guaranteed cleanup**. Commands can deliberately escape process-group termination; use an OS sandbox for stronger containment.

## Limits

A broker lease is not a program deadline. Linux provides no universal way to identify whether arbitrary code is blocked reading `/dev/tty`; readiness races with shell `read -t` remain. Stale-input prevention is best effort, not a guarantee. GNU timed prompts are not claimed to be fully supported.

Masked input is provisional UI masking. It does not isolate secrets from the command, another extension, terminal emulator, terminal scrollback, process memory, command-written files, or external recording. Output removal is best effort and does not erase external captures. Known Pi TUI debug logging env vars (`PI_TUI_WRITE_LOG`, `PI_TUI_DEBUG`, `PI_TUI_DEBUG_REDRAW`) block approval, attach, and release. Pi's global Shift+Ctrl+D debug callback is suppressed while approval, release-preview, and task screens are mounted, then restored without overwriting a replacement installed by another extension. This is not a logging sandbox: preconfigured terminal write loggers whose env vars were removed, crash dumps, other extensions/input listeners, and external recording cannot be reliably detected or disabled.

Responses travel from the local TUI to the broker over pipes and then through the PTY, never deliberately through argv, env, disk, or model input. Commands still inherit the usual environment. No askpass helper is forced. Actual sudo/doas, systemd, SSH, SFTP, GUI polkit, and full-screen applications are unvalidated; GUI polkit and full-screen terminal applications are unsupported.

## Tests

Requires Node.js 22.6+ with TypeScript stripping, Python 3, bash, and installed pinned development dependencies:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

Synthetic-only tests cover broker parent exit, cleanup, deadlines, prompt leases and stale responses; bounded registry ownership/history/logs; private result/error/update paths; explicit selected release and denial; visible approval warnings; concurrent screens; and session shutdown. No test contacts network services or performs live privileged authentication. Regression tests exercise the installed Pi TUI input dispatcher and actual InteractiveMode debug-file handler with a synthetic terminal, foreground cancel/abort, detach/reattach, and two waiting tasks. PTY tests inject SIGTERM before fork ownership assignment and verify cleanup and child signal-mask restoration. Physical-terminal appearance and key delivery still need manual validation.

The SDK dev dependencies are pinned to 0.87.1. The unresolved high-severity `brace-expansion@5.0.9` advisory comes from that SDK's published shrinkwrap; previous `npm audit fix` and a root override did not replace it. This change does not alter dependencies or the lockfile. Tests invoke system Python and JavaScript entry points, not native npm binaries.
