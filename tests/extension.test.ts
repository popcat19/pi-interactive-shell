// Purpose: Check registration, opt-in routing, and fail-closed behavior without credentials.
import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/extension.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

function fixture(enabled = false) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, () => void | Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const flags = new Map<string, string | boolean>();
  const api = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command); },
    registerFlag(name: string, options: { default: string | boolean }) { flags.set(name, options.default); },
    getFlag(name: string) { return flags.get(name); },
    on(name: string, handler: () => void) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  extension(api);
  flags.set("interactive-shell-bash", enabled);
  handlers.get("session_start")!();
  return { tools, handlers, commands };
}

test("disabled integration registers no bash override", () => {
  assert.equal(fixture().tools.has("bash"), false);
});
test("opt-in integration replaces bash and never calls stock execute outside TUI", async () => {
  const { tools } = fixture(true);
  for (const name of ["bash", "interactive_shell"]) {
    let updates = 0;
    const result = await tools.get(name)!.execute("test", { command: "printf synthetic-output" }, undefined, () => { updates++; }, { mode: "rpc", hasUI: true } as ExtensionContext);
    assert.equal(updates, 0);
    assert.deepEqual(result, { content: [{ type: "text", text: "Private shell status: unavailable. Output and responses withheld." }], details: undefined });
  }
});

test("approved background receipts, private leak boundaries, selected preview release, visible warning, and shutdown", async () => {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture();
  const previews: string[] = [];
  let approve = true, updates = 0;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: {
    notify() {},
    custom: async (factory: Function) => new Promise(resolve => {
      const screen = factory({ requestRender() {}, terminal: { columns: 1000 } }, {}, {}, resolve);
      previews.push(screen.render(1000).join("\n"));
      screen.handleInput(approve ? "y" : "\x1b");
    }),
  } } as unknown as ExtensionContext;
  const call = (name: string, args: object) => f.tools.get(name)!.execute("test", args, undefined, () => { updates++; }, ctx);
  const query = async (id: string, action = "read") => JSON.stringify(await call("shell_task", { id, action }));
  const waitDone = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const value = await query(id, "status");
      if (value.includes("completed")) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail("task did not complete");
  };
  try {
    const receipt = await call("interactive_shell", { command: "printf synthetic-only", background: true });
    assert.equal(receipt.details, undefined);
    assert(!JSON.stringify(receipt).includes("synthetic-only"));
    const id = JSON.parse((receipt.content[0] as { text: string }).text.split("\n")[0]).id;
    await waitDone(id);
    for (const action of ["list", "status", "read"]) assert(!(await query(id, action)).includes("synthetic-only"));
    approve = false;
    await f.commands.get("shell-release")!.handler(`${id} 0 14`, ctx);
    assert(previews.at(-1)!.includes('"synthetic-only"'));
    assert(!(await query(id)).includes("synthetic-only"));
    approve = true;
    await f.commands.get("shell-release")!.handler(`${id} 0 9`, ctx);
    assert(previews.at(-1)!.includes('"synthetic"'));
    assert((await query(id)).includes("synthetic"));
    assert(!(await query(id)).includes("synthetic-only"));
    assert(!(await query(id, "status")).includes("synthetic"));
    approve = false;
    const denied = await call("interactive_shell", { command: "printf synthetic-only", background: true, output: "visible" });
    assert(JSON.stringify(denied).includes("denied"));
    assert(previews.at(-1)!.includes("WARNING: programs can echo credentials"));
    approve = true;
    const visible = await call("interactive_shell", { command: "printf synthetic-only", background: true, output: "visible" });
    const visibleId = JSON.parse((visible.content[0] as { text: string }).text.split("\n")[0]).id;
    await waitDone(visibleId); assert((await query(visibleId)).includes("synthetic-only"));
    assert.equal(updates, 0);
    await f.handlers.get("session_shutdown")!();
    assert((await query(id)).includes("not-found"));
    assert((await query(visibleId)).includes("not-found"));
  } finally {
    await f.handlers.get("session_shutdown")!();
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("competing approvals fail busy; approval exceptions and session reset do not leak private data", async () => {
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture();
  let finish: ((value: boolean) => void) | undefined;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { custom: (factory: Function) => new Promise(resolve => {
    finish = resolve;
    factory({ requestRender() {}, terminal: { columns: 1000 } }, {}, {}, resolve);
  }) } } as unknown as ExtensionContext;
  const execute = () => f.tools.get("interactive_shell")!.execute("test", { command: "printf synthetic-only", background: true }, undefined, undefined, ctx);
  try {
    const pending = execute();
    assert(JSON.stringify(await execute()).includes("busy"));
    await f.handlers.get("session_start")!();
    finish?.(true);
    const denied = await pending;
    assert(!JSON.stringify(denied).includes("synthetic-only"));
    ctx.ui.custom = async () => { throw new Error("synthetic-only"); };
    const error = await execute();
    assert(JSON.stringify(error).includes("error"));
    assert(!JSON.stringify(error).includes("synthetic-only"));
  } finally {
    await f.handlers.get("session_shutdown")!();
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("real Pi TUI input suppresses debug across approval, focus and release; cancel awaits cleanup", async () => {
  const { TuiMainScreen } = await import("@earendil-works/pi-tui");
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture();
  let terminalInput!: (data: string) => void;
  const terminal = { columns: 1000, rows: 100, kittyProtocolActive: false,
    start(callback: (data: string) => void) { terminalInput = callback; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(`${tmpdir()}/pi-shell-debug-test-`);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const sdkRoot = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);
  const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js", sdkRoot).href);
  const { initTheme } = await import(new URL("modes/interactive/theme/theme.js", sdkRoot).href);
  const { getDebugLogPath } = await import(new URL("config.js", sdkRoot).href);
  const oldPackageDir = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = new URL("../", sdkRoot).pathname;
  try { initTheme("dark", false); } finally { if (oldPackageDir === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = oldPackageDir; }
  const captures: string[] = [];
  const debug = () => {
    InteractiveMode.prototype.handleDebugCommand.call({ ui: tui, session: { messages: [] }, chatContainer: { addChild() {} } });
    captures.push(readFileSync(getDebugLogPath(), "utf8"));
  };
  tui.onDebug = debug;
  tui.start();
  let screen: import("../src/private-screen.ts").PrivateScreen | undefined;
  let mount = 0;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { notify() {}, custom: (factory: Function) => new Promise(resolve => {
    screen = factory(tui, {}, {}, (value: unknown) => { tui.clear(); tui.setFocus(null); screen?.dispose(); resolve(value); });
    tui.addChild(screen!); tui.setFocus(screen!); mount++;
  }) } } as unknown as ExtensionContext;
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await pause(10); assert(condition()); };
  const hitDebug = () => { const count = captures.length; terminalInput("\x1b[100;6u"); assert.equal(captures.length, count); };
  const execute = (command: string, signal?: AbortSignal, background = false, policy = "private") => f.tools.get("interactive_shell")!.execute("t", { command, background, output: policy }, signal, undefined, ctx);
  const approve = () => { tui.render(1000); hitDebug(); terminalInput("y"); };
  const idOf = (r: Awaited<ReturnType<typeof execute>>) => JSON.parse((r.content[0] as { text: string }).text.split("\n")[0]).id;
  try {
    terminalInput("\x1b[100;6u"); assert.equal(captures.length, 1);
    let run = execute("printf '%s\\n' $$; sleep 30");
    approve(); await wait(() => mount === 2);
    await wait(() => /"[0-9]+\?/.test(screen!.render(1000).join("\n")));
    const rendered = screen!.render(1000).join("\n");
    const pid = Number(rendered.match(/"([0-9]+)\?/)![1]);
    hitDebug(); terminalInput("\x1b");
    const cancelled = await run;
    assert(JSON.stringify(cancelled).includes("cancelled"));
    assert.throws(() => process.kill(pid, 0));
    assert.equal(tui.onDebug, debug);

    const controller = new AbortController();
    const before = mount;
    run = execute("sleep 30", controller.signal); approve(); await wait(() => mount === before + 2);
    controller.abort(); assert(JSON.stringify(await run).includes("cancelled")); assert.equal(tui.onDebug, debug);

    const promptCommand = "stty -echo; printf 'Password: '; IFS= read -r x; test \"$x\" = synthetic-only";
    run = execute(promptCommand); approve(); await wait(() => screen!.render(1000).join("\n").includes("Response "));
    hitDebug(); terminalInput("\x04"); const firstId = idOf(await run);
    assert.equal(tui.onDebug, debug);
    run = execute(promptCommand, undefined, true, "visible"); approve(); const secondId = idOf(await run);
    await pause(250);
    const listed = await f.tools.get("shell_task")!.execute("t", { action: "list" }, undefined, undefined, ctx);
    assert.equal((JSON.stringify(listed).match(/waiting-for-user/g) ?? []).length, 2);
    for (const [id, policy] of [[firstId, "private"], [secondId, "visible"]]) {
      const attached = f.commands.get("shell-attach")!.handler(id, ctx);
      const text = screen!.render(1000).join("\n");
      assert(text.includes(id)); assert(text.includes(`output: ${policy}`));
      if (policy === "visible") assert(text.includes("echoed credentials"));
      hitDebug(); terminalInput("synthetic-only"); terminalInput("\r");
      await wait(() => screen!.render(1000).join("\n").includes("completed"));
      terminalInput("\r"); await attached; assert.equal(tui.onDebug, debug);
    }
    const release = f.commands.get("shell-release")!.handler(`${firstId} 0 9`, ctx);
    assert(screen!.render(1000).join("\n").includes("RELEASE EXACT")); hitDebug(); terminalInput("\x1b"); await release;
    assert.equal(tui.onDebug, debug);
    assert.equal(captures.length, 1);
    assert.equal(readFileSync(getDebugLogPath(), "utf8"), captures[0]);
    const old = process.env.PI_TUI_WRITE_LOG;
    process.env.PI_TUI_WRITE_LOG = "synthetic-blocked";
    try { assert(JSON.stringify(await execute("true")).includes("logging-blocked")); }
    finally { if (old === undefined) delete process.env.PI_TUI_WRITE_LOG; else process.env.PI_TUI_WRITE_LOG = old; }
  } finally {
    await f.handlers.get("session_shutdown")!(); tui.stop();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(directory, { recursive: true, force: true });
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});
