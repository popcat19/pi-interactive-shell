# Context

## Vocabulary

- Domain: private shell execution.
- Bounded context: this standalone Pi package and Python PTY broker.
- Infrastructure: `broker/pty-broker.py` owns Linux PTY lifecycle.
- Policy: `src/extension.ts` owns approval, mode, timeout, and opt-in bash decisions.
- UI: `src/private-screen.ts` owns provisional masking and transient TUI rendering.
- Supporting domain: `tests/` validates broker and extension contracts with synthetic inputs.

## Files

- `broker/pty-broker.py`: Purpose: mediate a private Linux PTY through bounded, generation-checked pipe messages.
- `src/private-screen.ts`: Purpose: render private approval, bounded output, and provisional masked input in Pi's TUI.
- `src/extension.ts`: Purpose: gate private PTY runs behind TUI approval and optional agent bash replacement.
- `tests/broker-test.py`: Purpose: exercise private PTY lifecycle and stale-response rejection using synthetic data.
- `tests/screen.test.ts`: Purpose: verify masked screen rendering, command escaping, and generation invalidation.
- `tests/extension.test.ts`: Purpose: check registration, opt-in routing, and fail-closed behavior without credentials.
