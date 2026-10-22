// Purpose: Verify immediate launch, automatic completion, input passthrough, and session cleanup.
import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/extension.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ShellScreen } from "../src/shell-screen.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i++) await pause(10);
  assert(condition());
}

function fixture() {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, () => Promise<void>>();
  const flags = new Map<string, unknown>(), messages: unknown[] = [];
  let screen: ShellScreen | undefined, mounts = 0;
  const debug = () => {};
  const tui = { onDebug: debug, requestRender() {}, terminal: { columns: 100, rows: 40 } };
  extension({
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {},
    registerFlag(name: string, options: { default: unknown }) { flags.set(name, options.default); },
    getFlag(name: string) { return flags.get(name); },
    on(name: string, handler: () => Promise<void>) { handlers.set(name, handler); },
    sendMessage(message: unknown) { messages.push(message); },
  } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: {
    notify() {}, setStatus() {},
    custom(factory: Function) { return new Promise(resolve => {
      screen = factory(tui, {}, {}, resolve); mounts++; screen!.render(100);
    }); },
  } } as unknown as ExtensionContext;
  const execute = (command: string, background = false, signal?: AbortSignal, timeout?: number) => tools.get("interactive_shell")!.execute("test", { command, background, timeout }, signal, undefined, ctx);
  return { tools, handlers, flags, messages, execute, ctx, tui, debug, screen: () => screen!, mounts: () => mounts };
}

test("non-TUI calls remain unavailable", async () => {
  const f = fixture();
  const result = await f.tools.get("interactive_shell")!.execute("t", { command: "true" }, undefined, undefined, { mode: "rpc", hasUI: true } as ExtensionContext);
  assert(JSON.stringify(result).includes("unavailable"));
  assert(!f.tools.has("bash"));
});

test("interactive lifecycle launches without approval and closes without confirmation", async () => {
  const descriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  const f = fixture();
  try {
    await f.handlers.get("session_start")!();
    assert.equal(f.flags.get("interactive-shell-timeout"), "0");
    for (const code of [0, 7]) {
      const before = f.mounts();
      const result = await f.execute(`printf 'output\\n'; exit ${code}`);
      assert.equal(f.mounts(), before + 1);
      assert(JSON.stringify(result).includes(`\\"exitCode\\":${code}`));
      assert(!JSON.stringify(result).includes("output?"));
      assert.equal(f.messages.length, 0);
      assert.equal(f.tui.onDebug, f.debug);
    }
    const run = f.execute("stty -echo; printf 'Password: '; read -r x; test \"$x\" = synthetic-only");
    await wait(() => f.screen().render(100).some(line => line.trim() === "Password:"));
    f.screen().handleInput("synthetic-only"); f.screen().handleInput("\r");
    const result = await run;
    assert(JSON.stringify(result).includes("completed")); assert(!JSON.stringify(result).includes("synthetic-only"));
    const cancelled = f.execute("sleep 30");
    assert(JSON.stringify(await f.execute("true")).includes("busy"));
    f.screen().handleInput("\x1b");
    assert(JSON.stringify(await cancelled).includes("cancelled"));
    const controller = new AbortController();
    const aborted = f.execute("sleep 30", false, controller.signal); controller.abort();
    assert(JSON.stringify(await aborted).includes("cancelled"));
    const detached = f.execute("sleep .2; printf detached"); f.screen().handleInput("\x1d"); await detached;
    await wait(() => f.messages.length === 1);
    await f.execute("printf background", true);
    await wait(() => f.messages.length === 2);
    assert(JSON.stringify(f.messages).includes("background"));
    const timed = await f.execute("sleep 30", false, undefined, 0.2);
    assert(JSON.stringify(timed).includes("timeout"));
    const prior = process.env.PI_TUI_WRITE_LOG;
    process.env.PI_TUI_WRITE_LOG = "blocked";
    try { assert(JSON.stringify(await f.execute("true")).includes("logging-blocked")); }
    finally { if (prior === undefined) delete process.env.PI_TUI_WRITE_LOG; else process.env.PI_TUI_WRITE_LOG = prior; }
  } finally {
    await f.handlers.get("session_shutdown")!();
    [process.stdin, process.stdout].forEach((stream, index) => {
      if (descriptors[index]) Object.defineProperty(stream, "isTTY", descriptors[index]!); else Reflect.deleteProperty(stream, "isTTY");
    });
  }
});
