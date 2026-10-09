# pi-interactive-shell

Approval-gated Linux PTY execution for Pi. The extension is standalone and does not install itself, change Pi settings, publish, contact a network, invoke sudo/doas, or cache credentials.

## Load locally

```sh
cd /home/popcat19/pi-interactive-shell
PI_CODING_AGENT_DIR=/tmp/pi-interactive-shell-settings pi --no-session --no-extensions -e ./src/extension.ts
```

Use `/shell COMMAND`. Pi must be in its interactive Linux TUI with TTY stdin and stdout. The exact command is shown as JSON-escaped text before approval. `interactive_shell` is available to the model and returns status only. The extension displays output only inside a transient custom TUI screen, masks responses, and does not deliberately copy either into tool results, session messages, logs, argv, env, or temp files. Results include a coarse status and, when available, the command exit code; negative codes indicate signal termination. External recording and command behavior remain outside this guarantee.

Enable the existing agent bash integration only per launch:

```sh
pi --extension ./src/extension.ts --interactive-shell-bash
```

When that flag is absent, the built-in `bash` registration is untouched. This implementation registers the replacement after `session_start`, which matches Pi's registration/override API. Disabled mode preserves the built-in bash tool.

## Controls and policy

- Every run requires approval. Agent-originated runs cannot approve themselves.
- Default run deadline is 300 seconds and is configurable with `--interactive-shell-timeout`, bounded to 1..3600 seconds.
- Prompt leases default to 30 seconds and are configurable with `--interactive-shell-lease`, bounded to 1..120 seconds.
- Prompts are detected from termios ECHO changes and bounded text cues. Ctrl+P opens manual masked input.
- Input has a serial ID, a finite lease, termios/readiness checks, process-alive check, and a final write check. Expired or stale input is dropped.
- Only one run is admitted. Runs fail closed outside the interactive TUI, on known Pi TUI debug logging env vars, and on invalid config.
- Timeout/cancel kills the PTY process group. Grandchild cleanup is best effort and does not protect against malicious commands.
- Output is ASCII/control sanitized and bounded in memory. It is not retained in a file.

## Limits

A broker lease is not a program deadline. Linux provides no universal way to identify whether arbitrary code is blocked reading `/dev/tty`, and readiness can race a shell `read -t`; stale-input prevention is therefore best effort, not a guarantee. GNU timed prompts are not claimed to be fully supported. There is no automatic retry or secret resubmission.

Masked input is provisional UI masking. It does not isolate secrets from the command, another extension, the terminal emulator, terminal scrollback, process memory, command-written files, or external recording. Output removal is best effort and does not erase terminal scrollback or external captures. Known Pi TUI debug logging is rejected when the extension can inspect its environment; logging configured outside those variables is not detectable.

The extension does not create or cache credentials or force askpass. Responses entered in the private masked screen are passed to the approved command through its PTY, including authentication responses. Never put credentials in command arguments or chat. Terminal-based authentication is the intended use; actual sudo/doas, systemd, SSH, and SFTP integrations have not been validated. GUI polkit dialogs and full-screen terminal applications are not supported.

## Tests

Requires Node.js 22.6+ with TypeScript stripping, npm, Python 3, and bash. Install the pinned development SDK dependencies before testing:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests use synthetic `synthetic-only` values and local shell binaries. They do not contact network services, use sudo, or perform privileged operations. The lockfile pins the development dependency tree, including Pi SDK 0.87.1. `npm audit` reports one high-severity advisory group for `brace-expansion@5.0.9` pinned by that SDK's published shrinkwrap; `npm audit fix` and a root override did not replace it. This remains unresolved in the development SDK dependency tree. Tests invoke system Python and JavaScript entry points, with no native npm executable requirement.
