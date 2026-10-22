# pi-interactive-shell

Linux PTY commands with direct local terminal input and session-owned background tasks. Commands launch immediately, with no y/n approval screen. Command output reaches the model and transcript; program-echoed credentials are not redacted.

## Load and commands

```sh
pi --no-session --no-extensions -e ./src/extension.ts
```

Requires Linux, Python 3, bash, and Pi's interactive TUI with TTY stdin and stdout.

| Command | Action |
|---|---|
| `/shell COMMAND` | Run in the foreground |
| `/shell-bg COMMAND` | Start a background task |
| `/shell-tasks` | List session task IDs and status |
| `/shell-attach ID` | Attach to an active task |
| `/shell-stop ID` | Stop a task and await cleanup |

`interactive_shell` accepts `command`, optional `timeout` (0..3600 seconds), and optional `background`. Zero or an omitted timeout disables the runtime deadline by default. `--interactive-shell-timeout` sets a default explicit deadline. Prompt input has no lease or AFK timeout; the old `--interactive-shell-lease` flag is accepted but ignored.

`--interactive-shell-bash` optionally routes agent bash calls through this PTY. Without it, stock bash is unchanged.

## Terminal interaction

Input is available throughout an attached task, even without a detected prompt. Keystrokes go directly to the PTY. The program controls echo, including hiding passwords for SSH and `su`. Input is never automatically suffixed with a question mark. PTY carriage returns are removed from displayed output so ordinary newlines do not produce trailing question marks.

- Esc stops the task and awaits cleanup.
- Ctrl+] detaches without stopping. `/shell-attach ID` reconnects.
- Ctrl+C and Ctrl+D pass through to the program for interrupt and EOF.
- Enter, Tab, Backspace, arrow keys, Home, End, Delete, and Ctrl letter combinations pass through.
- PgUp/PgDn browses retained output.
- Terminal dimensions are sent to the child PTY when the screen renders at a new size.

Both successful and failed exits close the task screen automatically. There is no exit confirmation. Completed output is available through `shell_task` read/status calls.

SSH and `su` use the same interactive path. Prompt recognition supplies context and opens background tasks when input appears necessary; it never gates attached input. Automatic screens stay attached after a response so a login can proceed into its interactive shell. Only one screen owns input at a time. Detached prompt generations do not repeatedly reopen.

This is a bounded text view, not a full terminal emulator. Output controls are sanitized; full-screen applications, color rendering, and cursor-addressed screen layouts are unsupported. Actual remote SSH authentication and privileged `su` authentication require manual validation. Tests use local synthetic PTYs.

## Ownership and output

Tasks belong to the current Pi session. Shutdown and session replacement stop active brokers and erase retained output. Stop terminates the PTY process group and reaps the shell child. Processes that create independent sessions are not guaranteed cleanup. No durable services or cross-process reconnects are supported.

At most eight tasks run concurrently. History retains sixteen tasks; completed output expires after ten minutes. Each task retains the latest 16384 sanitized characters. Background calls return a launch receipt, not proof of readiness. `shell_task` supports list, status, read, and stop; it cannot submit terminal input.

Background, detached, and local-command tasks publish one completion message containing status, exit code, and bounded output. Foreground tool calls return their terminal result without a duplicate message. Completion delivery waits while another shell screen owns focus. Session replacement discards pending reports.

Known Pi debug logging environment variables block interactive screens. The global debug callback is suppressed during task focus and restored afterward. Program output, terminal recording, other extensions, and process memory remain outside input privacy guarantees. Never place credentials in command arguments or chat.

## Validation

```sh
npm run typecheck
npm test
```

Tests cover local PTY input without prompts, password echo behavior, task cleanup, output bounds, explicit deadlines, immediate launch, automatic exit, detach, background completion, screen controls, and resize dispatch. Physical-terminal rendering, real SSH/su authentication, and accessibility need manual validation.
