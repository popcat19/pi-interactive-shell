# Context

## Vocabulary

- Domain: interactive shell input.
- Bounded context: this standalone Pi package and Python PTY broker.
- Infrastructure: `broker/pty-broker.py` owns Linux PTY lifecycle.
- Policy: `src/extension.ts` owns local approval, serialized generation-checked prompt focus, session-owned completion delivery, and opt-in bash decisions.
- Aggregate root: `src/task-registry.ts` owns bounded in-memory session tasks, live prompt context, and broker lifetimes.
- UI: `src/shell-screen.ts` owns provisional masking and transient TUI rendering.
- Supporting domain: `tests/` validates broker and extension contracts with synthetic inputs.

## Files

- `broker/pty-broker.py`: Purpose: mediate a private Linux PTY through bounded, generation-checked pipe messages.
- `src/shell-screen.ts`: Purpose: render actionable approval, bounded output, and provisional masked input in Pi's TUI.
- `src/extension.ts`: Purpose: gate session PTY tasks and masked input behind local TUI approval.
- `src/debug-guard.ts`: Purpose: suppress Pi's global debug dump callback while sensitive custom screens are mounted.
- `src/task-registry.ts`: Purpose: own bounded session PTY tasks independently of transient input screens.
- `tests/broker-test.py`: Purpose: exercise private PTY lifecycle and stale-response rejection using synthetic data.
- `tests/screen.test.ts`: Purpose: verify masked screen rendering, command escaping, and generation invalidation.
- `tests/extension.test.ts`: Purpose: check registration, opt-in routing, and fail-closed behavior without credentials.
- `tests/registry.test.ts`: Purpose: verify bounded task ownership, bounded output, prompt generations, and process cleanup.
