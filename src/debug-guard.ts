// Purpose: Suppress Pi's global debug dump callback while sensitive custom screens are mounted.
export function suppressDebug(tui: { onDebug?: () => void }): () => void {
  const previous = tui.onDebug;
  // A no-op consumes the debug key before it can reach masked response input.
  const blocked = () => {};
  tui.onDebug = blocked;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // Do not overwrite a callback installed by another extension during this screen.
    if (tui.onDebug === blocked) tui.onDebug = previous;
  };
}
