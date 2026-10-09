# pi-interactive-shell

Approval-gated Linux PTY commands with local masked input and session-owned background tasks. **Command output is returned to the model.** There is no output-sharing policy, release step, or secret redaction.

## Load and commands

```sh
pi --no-session --no-extensions -e ./src/extension.ts
```

Requires Linux, Python 3, bash, and Pi's interactive TUI with TTY stdin and stdout.

| Command | Action |
|---|---|
| `/shell COMMAND` | Approve and run in the foreground |
| `/shell-bg COMMAND` | Approve and start a background task |
| `/shell-tasks` | List session task IDs and status |
| `/shell-attach ID` | Focus task output and masked input |
| `/shell-stop ID` | Stop the task and await cleanup |

`interactive_shell` takes `command`, optional `timeout` (1..3600 seconds), and optional `background` (default false). Foreground results return task metadata and the latest bounded sanitized output. Background calls return an ID immediately after approval. `shell_task` takes `action` (`list`, `status`, `read`, `stop`) and `id` except for list. Status, read, and stop return latest output; list returns metadata. Tools cannot submit responses. Local commands display output through the task screen; reattach to browse completed output.

Enable optional approval-gated agent bash only per launch:

```sh
pi --extension ./src/extension.ts --interactive-shell-bash
```

Without that flag, stock bash is untouched. The replacement uses the same bounded-output and masked-input path.

## Actionable terminal controls

Approval asks `:: Run this command? [y/N]`. Enter, `n`, or Esc denies. The exact command is JSON-escaped to make controls inert and visible. The approval warns that command output reaches the model/transcript and echoed credentials are exposed. Review every page using Left/Right, then press `y` on the last page. Unrendered pages cannot be approved; resizing restarts review.

Task screens show task ID, running/completed state, or **Waiting for your input**. State remains readable without color; Pi semantic theme colors emphasize headings. Output is sanitized actual multiline text, not quoted JSON.

- PgUp/PgDn browses retained output. Returning to the last page follows new output.
- Enter submits a masked response once; Ctrl+U clears provisional input.
- Ctrl+P requests a fresh manual prompt when automatic detection misses it or its lease expires.
- Ctrl+D detaches without stopping the task; `/shell-attach ID` reconnects.
- Esc or Ctrl+C stops a running task and waits for cleanup before its receipt returns.
- Enter or Esc closes a completed screen; it also auto-closes after 10 seconds.

Layouts are bounded by terminal height and width. Very small terminals show an enlarge-terminal instruction instead of accepting an unreadable approval. One screen can own interactive input at a time; competing requests return `busy`.

Background prompts never steal focus. One local notification per task and a persistent status line say `Waiting for your input` and provide `/shell-attach ID`. Later prompt generations update only the status line. The hint clears on expiry, invalidation, submission, attachment, stop, or completion; detaching an active prompt restores it without another notification. No typed response is copied into those notifications. An expired prompt lease requires Ctrl+P on attachment if no fresh prompt is detected.

## Timeouts and ownership

**Runtime timeout includes time waiting for human input**, including background authentication. Default runtime remains 300 seconds; `--interactive-shell-timeout` and per-call `timeout` accept 1..3600 seconds. A timeout alone does not establish why a particular output file was missing; inspect returned output and exit status.

Prompt leases remain 30 seconds by default; `--interactive-shell-lease` accepts 1..120 seconds. Reattach preserves the remaining lease. Output, termios changes, expiry, submission, stop, and exit invalidate provisional input. There is no retry, resubmission, or credential caching. Approval expires after 60 seconds.

At most 8 tasks run concurrently. History retains at most 16 tasks, evicting completed tasks first. Completed output expires after 10 minutes, swept every second. Logs retain only the last 16384 ASCII-sanitized characters per task in memory. Protocol parsing and pending writes are bounded. No complete log file is created.

Session shutdown, reload, replacement, and fork clear ownership and retained task output. Stop terminates the broker, which terminates the PTY process group and reaps its shell child. The broker watchdog escalates after 1.5 seconds; the run watchdog acts 2 seconds after the broker deadline. Protected fork ownership and Linux parent-death signaling cover normal cancellation and abrupt Pi exit.

No durable services, restarts, or cross-process reconnects are supported. Descendants that detach into another process group/session are **not guaranteed cleanup**. Commands can escape process-group containment; use an OS sandbox for stronger guarantees.

## Input security and limits

Never put credentials in command arguments or chat. Responses go from local masked input through a pipe to the broker and PTY, not directly into model results, session messages, argv, env, or files. Commands inherit the usual environment. **If the program echoes or prints a response, that output reaches the model and session transcript.** Masking is not redaction.

Other extensions, process memory, terminal scrollback, command-written files, and external recordings are outside this protection. Known Pi logging env vars (`PI_TUI_WRITE_LOG`, `PI_TUI_DEBUG`, `PI_TUI_DEBUG_REDRAW`) block interactive screens. The global Shift+Ctrl+D debug callback is suppressed during approval and input screens, then restored safely. This does not disable preconfigured loggers with removed env vars, crash dumps, other input listeners, or external recording.

Linux cannot universally prove a process is blocked reading `/dev/tty`; shell timed-read races remain best effort. Prompt detection uses termios and bounded text cues; arbitrary applications can require Ctrl+P. Actual sudo/doas, SSH, SFTP, and systemd integrations remain unvalidated. GUI polkit and full-screen applications are unsupported.

## Validation

With installed pinned dev dependencies:

```sh
npm test
npm run typecheck
```

Tests use synthetic responses and local commands, with no privileged or network authentication. They cover visible output by default, command echo behavior, background prompt detection and timeout, masked input, task lifecycle, approval rendering, bounded layout/paging, and actual Pi TUI debug dispatch with a synthetic terminal. Physical-terminal appearance, screen-reader behavior, and key delivery still need manual validation.

SDK dev dependencies remain pinned to 0.87.1. The existing unresolved `brace-expansion@5.0.9` advisory comes from its published shrinkwrap. This change does not alter dependencies or the lockfile, install itself, modify settings, or publish.
