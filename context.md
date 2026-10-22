# Context

## Vocabulary

- Domain: interactive shell input.
- Bounded context: this standalone Pi package and Python PTY broker.
- Infrastructure: `broker/pty-broker.py` owns Linux PTY lifecycle.
- Policy: `src/extension.ts` owns serialized prompt focus, session-owned completion delivery, and opt-in bash decisions.
- Aggregate root: `src/task-registry.ts` owns bounded in-memory session tasks, live prompt context, and broker lifetimes.
- UI: `src/shell-screen.ts` owns direct PTY input and transient TUI rendering.
- Supporting domain: `tests/` validates broker and extension contracts with synthetic inputs.

## Files

- `broker/pty-broker.py`: Purpose: mediate a private Linux PTY through bounded, generation-checked pipe messages.
- `src/shell-screen.ts`: Purpose: display bounded PTY output and forward local input while a task runs.
- `src/extension.ts`: Purpose: run session PTY tasks with local interactive terminal input.
- `src/debug-guard.ts`: Purpose: suppress Pi's global debug dump callback while sensitive custom screens are mounted.
- `src/task-registry.ts`: Purpose: own bounded session PTY tasks independently of transient input screens.
- `tests/broker-test.py`: Purpose: exercise private PTY lifecycle and stale-response rejection using synthetic data.
- `tests/screen.test.ts`: Purpose: verify interactive PTY screen input, rendering, and task lifecycle controls.
- `tests/extension.test.ts`: Purpose: verify immediate launch, automatic completion, input passthrough, and session cleanup.
- `tests/registry.test.ts`: Purpose: verify bounded task ownership, bounded output, prompt generations, and process cleanup.
