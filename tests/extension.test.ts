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
  return { tools, handlers, commands, flags };
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
    assert.deepEqual(result, { content: [{ type: "text", text: "Shell status: unavailable." }], details: undefined });
  }
});

test("background output is returned without policy choices; simplified commands and shutdown", async () => {
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
    for (const action of ["status", "read", "stop"]) assert((await query(id, action)).includes("synthetic-only"));
    assert(!JSON.stringify(f.tools.get("interactive_shell")!.parameters).includes('"output"'));
    assert.deepEqual([...f.commands.keys()].sort(), ["shell", "shell-attach", "shell-bg", "shell-stop", "shell-tasks"]);
    assert(previews[0].includes("Echoed credentials are exposed"));
    assert.equal(updates, 0);
    await f.handlers.get("session_shutdown")!();
    assert((await query(id)).includes("not-found"));
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

test("real Pi TUI input suppresses debug across approval and focus; cancel awaits cleanup", async () => {
  const { TuiMainScreen } = await import("@earendil-works/pi-tui");
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture(true);
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
  let screen: import("../src/shell-screen.ts").ShellScreen | undefined;
  let mount = 0;
  const notices: string[] = [];
  const statuses: string[] = [];
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { notify(text: string) { notices.push(text); }, setStatus(_key: string, text: string) { if (text) statuses.push(text); }, custom: (factory: Function) => new Promise(resolve => {
    screen = factory(tui, {}, {}, (value: unknown) => { tui.clear(); tui.setFocus(null); screen?.dispose(); resolve(value); });
    tui.addChild(screen!); tui.setFocus(screen!); mount++;
  }) } } as unknown as ExtensionContext;
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await pause(10); assert(condition()); };
  const hitDebug = () => { const count = captures.length; terminalInput("\x1b[100;6u"); assert.equal(captures.length, count); };
  const execute = (command: string, signal?: AbortSignal, background = false) => f.tools.get("interactive_shell")!.execute("t", { command, background }, signal, undefined, ctx);
  const approve = () => { tui.render(1000); hitDebug(); terminalInput("y"); };
  const idOf = (r: Awaited<ReturnType<typeof execute>>) => JSON.parse((r.content[0] as { text: string }).text.split("\n")[0]).id;
  try {
    terminalInput("\x1b[100;6u"); assert.equal(captures.length, 1);
    let run = execute("printf '%s\\n' $$; sleep 30");
    approve(); await wait(() => mount === 2);
    await wait(() => /[0-9]+\?/.test(screen!.render(1000).join("\n")));
    const rendered = screen!.render(1000).join("\n");
    const pid = Number(rendered.match(/([0-9]+)\?/)![1]);
    hitDebug(); terminalInput("\x1b");
    const cancelled = await run;
    assert(JSON.stringify(cancelled).includes("cancelled"));
    assert.throws(() => process.kill(pid, 0));
    assert.equal(tui.onDebug, debug);

    for (const name of ["interactive_shell", "bash"]) {
      const beforeOutput = mount;
      const normal = f.tools.get(name)!.execute("o", { command: "printf synthetic-output" }, undefined, undefined, ctx);
      approve(); await wait(() => mount === beforeOutput + 2);
      await wait(() => screen!.render(1000).join("\n").includes("completed"));
      terminalInput("\r");
      assert(JSON.stringify(await normal).includes("synthetic-output"));
    }
    const local = f.commands.get("shell")!.handler("printf local-output", ctx);
    const localMount = mount;
    approve(); await wait(() => mount === localMount + 1);
    await wait(() => screen!.render(1000).join("\n").includes("completed"));
    assert(screen!.render(1000).join("\n").includes("local-output"));
    terminalInput("\r"); await local;

    const controller = new AbortController();
    const before = mount;
    run = execute("sleep 30", controller.signal); approve(); await wait(() => mount === before + 2);
    controller.abort(); assert(JSON.stringify(await run).includes("cancelled")); assert.equal(tui.onDebug, debug);

    const promptCommand = "stty -echo; printf 'Password: '; IFS= read -r x; test \"$x\" = synthetic-only";
    run = execute(promptCommand); approve(); await wait(() => screen!.render(1000).join("\n").includes("Response "));
    hitDebug(); terminalInput("\x04"); const firstId = idOf(await run);
    assert.equal(tui.onDebug, debug);
    run = execute(promptCommand, undefined, true); approve(); const secondId = idOf(await run);
    await pause(250);
    assert(notices.some(text => text.includes(secondId) && text.includes("Waiting for your input")));
    assert(statuses.some(text => text.includes(secondId)));
    const listed = await f.tools.get("shell_task")!.execute("t", { action: "list" }, undefined, undefined, ctx);
    assert.equal((JSON.stringify(listed).match(/waiting-for-user/g) ?? []).length, 2);
    terminalInput("\x04"); await pause(20);
    for (const id of [firstId, secondId]) {
      const attached = f.commands.get("shell-attach")!.handler(id, ctx);
      const text = screen!.render(1000).join("\n");
      assert(text.includes(id)); assert(text.includes("Waiting for your input"));
      hitDebug(); terminalInput("synthetic-only"); terminalInput("\r");
      await wait(() => screen!.render(1000).join("\n").includes("completed"));
      terminalInput("\r"); await attached; assert.equal(tui.onDebug, debug);
      const read = await f.tools.get("shell_task")!.execute("r", { action: "read", id }, undefined, undefined, ctx);
      assert(!JSON.stringify(read).includes("synthetic-only"));
      assert(JSON.stringify(read).includes("Password:"));
    }
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

test("repeated detached prompts notify once and clear persistent hints on expiry and output", async () => {
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture(); f.flags.set("interactive-shell-lease", "1");
  const notices: string[] = [], changes: (string | undefined)[] = [];
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: {
    notify(text: string) { notices.push(text); },
    setStatus(_key: string, text: string | undefined) { changes.push(text); },
    custom: (factory: Function) => new Promise(resolve => {
      const screen = factory({ requestRender() {}, terminal: { columns: 1000, rows: 100 } }, {}, {}, resolve);
      screen.render(1000); screen.handleInput("y");
      if (screen.render(1000).join("\n").includes("Waiting for your input")) screen.handleInput("\x04");
    }),
  } } as unknown as ExtensionContext;
  try {
    const receipt = await f.tools.get("interactive_shell")!.execute("t", { command: "stty -echo; printf 'Password: '; sleep 1.5; printf 'Password: '; sleep .4; printf changed; sleep 2", background: true }, undefined, undefined, ctx);
    const id = JSON.parse((receipt.content[0] as { text: string }).text.split("\n")[0]).id;
    for (let i = 0; i < 150 && changes.length < 4; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(changes.slice(0, 4).map(Boolean), [true, false, true, false]);
    assert.equal(notices.length, 1);
    assert(notices[0].includes(id));
    await f.tools.get("shell_task")!.execute("s", { action: "stop", id }, undefined, undefined, ctx);
    assert.equal(changes.at(-1), undefined); assert.equal(notices.length, 1);
  } finally {
    await f.handlers.get("session_shutdown")!();
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("automatic prompts queue behind approval, serialize, avoid detach loops, expire and reset", async () => {
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture();
  let screen!: import("../src/shell-screen.ts").ShellScreen;
  let mounts = 0;
  const notices: string[] = [];
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { notify(text: string) { notices.push(text); }, setStatus() {}, custom: (factory: Function) => new Promise(resolve => {
    screen = factory({ requestRender() {}, terminal: { columns: 100, rows: 40 } }, {}, {}, (value: unknown) => resolve(value));
    mounts++;
  }) } } as unknown as ExtensionContext;
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await pause(10); assert(condition()); };
  const launch = () => f.tools.get("interactive_shell")!.execute("t", { command: "sleep .3; stty -echo; printf '[sudo] password for synthetic-user: '; read -r x; sleep .3; printf 'Next password: '; read -r x", background: true }, undefined, undefined, ctx);
  const approve = () => { screen.render(100); screen.handleInput("y"); };
  try {
    let receipt = launch(); approve(); await receipt;
    const second = launch();
    await pause(650);
    assert.equal(mounts, 2); // Approval holds focus while first prompt queues.
    approve(); await second; await wait(() => mounts === 3);
    assert(screen.render(100).join("\n").includes("[sudo] password for synthetic-user:"));
    assert(notices[0].includes("[sudo] password for synthetic-user:"));
    await pause(600); assert.equal(mounts, 3);
    screen.handleInput("\x04"); await wait(() => mounts === 4);
    screen.handleInput("\x04"); await pause(100); assert.equal(mounts, 4);
    // Both live generations were detached, so neither reopens.
    const list = await f.tools.get("shell_task")!.execute("l", { action: "list" }, undefined, undefined, ctx);
    const tasks = JSON.parse((list.content[0] as { text: string }).text);
    assert.equal(tasks.length, 2); assert(tasks.every((t: { prompt: string }) => t.prompt.includes("[sudo]")));
    const attached = f.commands.get("shell-attach")!.handler(tasks[0].id, ctx);
    screen.render(100); screen.handleInput("synthetic-only"); screen.handleInput("\r");
    screen.handleInput("\x04"); await attached;
    const beforeNext = mounts;
    await wait(() => mounts > beforeNext);
    assert(screen.render(100).join("\n").includes("Next password:"));
    screen.handleInput("\x04"); await pause(30);
    await f.handlers.get("session_start")!();
    f.flags.set("interactive-shell-lease", "1");
    receipt = launch(); approve(); await receipt;
    const blocker = launch();
    await pause(1600); const beforeExpiry = mounts;
    screen.handleInput("\x1b"); await blocker; await pause(100);
    assert.equal(mounts, beforeExpiry); // Expired queued generation must not focus.
    await f.handlers.get("session_start")!();
    receipt = launch(); approve(); await receipt;
    const switching = launch(); await pause(650);
    const beforeSwitch = mounts;
    await f.handlers.get("session_start")!(); await switching; await pause(100);
    assert.equal(mounts, beforeSwitch);
  } finally {
    await f.handlers.get("session_shutdown")!();
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("actual dispatcher retains interrupted input against editor and queued task, including old timer horizon", async () => {
  const { TuiMainScreen } = await import("@earendil-works/pi-tui");
  const { TaskRegistry } = await import("../src/task-registry.ts");
  type Task = import("../src/task-registry.ts").ShellTask;
  const originalStart = TaskRegistry.prototype.start;
  const tasks: Task[] = [];
  TaskRegistry.prototype.start = function (...args) { const task = originalStart.apply(this, args); if (task) tasks.push(task); return task; };
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const f = fixture();
  let dispatch!: (data: string) => void;
  const tui = new TuiMainScreen({ columns: 100, rows: 40, kittyProtocolActive: false,
    start(callback: (data: string) => void) { dispatch = callback; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  });
  const editorInput: string[] = [];
  const editor = { render: () => ["sentinel editor"], invalidate() {}, handleInput: (data: string) => editorInput.push(data) };
  let screen!: import("../src/shell-screen.ts").ShellScreen;
  let mounts = 0;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { notify() {}, setStatus() {}, custom: (factory: Function) => new Promise(resolve => {
    screen = factory(tui, {}, {}, (value: unknown) => { tui.clear(); tui.addChild(editor); tui.setFocus(editor); screen.dispose(); resolve(value); });
    tui.clear(); tui.addChild(screen); tui.setFocus(screen); mounts++;
  }) } } as unknown as ExtensionContext;
  tui.start();
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  const frame = (task: Task, ...events: object[]) => (task as unknown as { receive(data: string): void }).receive(events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const prompt = (id: number) => ({ type: "prompt", id, lease: 60, text: `Synthetic request ${id}:` });
  const launch = async () => {
    const receipt = f.tools.get("interactive_shell")!.execute("t", { command: "sleep 30", background: true }, undefined, undefined, ctx);
    tui.render(100); dispatch("y"); await receipt;
  };
  try {
    await launch(); await launch();
    const [first, second] = tasks;
    const sent: object[] = [];
    (first as unknown as { send(message: object): void }).send = message => sent.push(message);
    frame(first, prompt(1)); await pause(10);
    frame(second, prompt(1)); await pause(10);
    const owner = screen, initialMounts = mounts;
    dispatch("synthetic-prefix");
    frame(first, { type: "invalidate" }, { type: "output", text: "changed" }, prompt(2));
    dispatch("synthetic-suffix"); dispatch("\r");
    assert.equal(screen, owner); assert.equal(mounts, initialMounts);
    assert.deepEqual(editorInput, []); assert.deepEqual(sent, []);
    assert(screen.render(100).join("\n").includes("Input interrupted"));
    // A deliberate manual refresh accepts adjacent invalidate/prompt frames in this owner.
    first.manual = () => frame(first, { type: "invalidate" }, prompt(3));
    dispatch("\x10");
    assert(screen.render(100).join("\n").includes("Synthetic request 3:"));
    dispatch("synthetic-valid"); dispatch("\r");
    assert(sent.some(m => JSON.stringify(m).includes('"value":"synthetic-valid"')));
    await pause(10);
    assert(screen.render(100).join("\n").includes(second.id));
    const secondOwner = screen;
    dispatch("synthetic-prefix");
    frame(second, { type: "invalidate" }, { type: "done", status: "completed", exitCode: 0 });
    dispatch("synthetic-suffix"); dispatch("\r");
    await pause(10100);
    dispatch("synthetic-after-timer"); dispatch("\r");
    assert.equal(screen, secondOwner); assert.deepEqual(editorInput, []);
    assert(screen.render(100).join("\n").includes("Input interrupted"));
    dispatch("\x04"); await pause(10);
    // A closing listener must not consume a fresh generation in the same batch.
    frame(first, prompt(4)); await pause(10);
    const closingOwner = screen;
    dispatch("\x04"); frame(first, { type: "invalidate" }, prompt(5));
    await pause(20);
    assert.notEqual(screen, closingOwner);
    assert(screen.render(100).join("\n").includes("Synthetic request 5:"));
    dispatch("synthetic-prefix");
    frame(first, { type: "invalidate" }); // Broker lease-expiry event.
    dispatch("synthetic-suffix"); dispatch("\r");
    assert.deepEqual(editorInput, []);
    assert(screen.render(100).join("\n").includes("Input interrupted"));
    const old = screen; dispatch("\x04"); await pause(10);
    old.handleInput("synthetic-disposed"); old.handleInput("\r");
    assert.equal(sent.filter(m => JSON.stringify(m).includes('"type":"input"')).length, 1);
  } finally {
    await f.handlers.get("session_shutdown")!(); tui.stop(); TaskRegistry.prototype.start = originalStart;
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});
