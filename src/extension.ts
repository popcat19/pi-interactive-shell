// Purpose: Gate session PTY tasks and masked input behind local TUI approval.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { suppressDebug } from "./debug-guard.ts";
import { ShellScreen } from "./shell-screen.ts";
import { TaskRegistry, type ShellTask } from "./task-registry.ts";

const LOGGING = ["PI_TUI_WRITE_LOG", "PI_TUI_DEBUG", "PI_TUI_DEBUG_REDRAW"];
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const statusResult = (status: string) => result(`Shell status: ${status}.`);
export default function extension(pi: ExtensionAPI) {
  let registry = new TaskRegistry();
  let busy = false;
  const pending = new Map<string, { task: ShellTask; generation: number; owner: TaskRegistry; ctx: ExtensionContext }>();
  const focused = new WeakMap<ShellTask, number>();
  function drain() {
    if (busy) return;
    for (const [id, item] of pending) {
      pending.delete(id);
      if (item.owner !== registry || registry.get(id) !== item.task || item.task.pendingPrompt()?.id !== item.generation || focused.get(item.task) === item.generation || !available(item.ctx) || logging()) continue;
      busy = true;
      void focus(item.task, item.ctx, undefined, true).catch(() => {}).finally(() => { busy = false; drain(); });
      break;
    }
  }
  let closeActive: (() => void) | undefined;
  pi.registerFlag("interactive-shell-bash", { type: "boolean", default: false, description: "Require approval and broker ALL agent bash calls" });
  pi.registerFlag("interactive-shell-timeout", { type: "string", default: "300", description: "Task deadline in seconds, 1..3600" });
  pi.registerFlag("interactive-shell-lease", { type: "string", default: "30", description: "Masked prompt lease in seconds, 1..120" });
  const available = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI && process.stdin.isTTY && process.stdout.isTTY && process.platform === "linux";
  const logging = () => LOGGING.some(key => Boolean(process.env[key]));
  async function approve(text: string, heading: string, ctx: ExtensionContext, signal?: AbortSignal) {
    let restoreDebug: (() => void) | undefined;
    let screen: ShellScreen | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
        restoreDebug = suppressDebug(tui);
        cancel = () => done(false);
        closeActive = cancel;
        screen = new ShellScreen(text, { approve: () => done(!signal?.aborted && !logging()), cancel, close: cancel, manual() {}, submit() {} }, () => tui.requestRender(), heading, () => tui.terminal?.columns ?? 0, () => tui.terminal?.rows ?? 24, (role, text) => theme.fg?.(role, text) ?? text);
        timer = setTimeout(cancel, 60000);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) queueMicrotask(cancel);
        return screen;
      });
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
      clearTimeout(timer); screen?.dispose(); restoreDebug?.(); closeActive = undefined;
    }
  }
  async function focus(task: ShellTask, ctx: ExtensionContext, signal?: AbortSignal, automatic = false) {
    let restoreDebug: (() => void) | undefined;
    let screen: ShellScreen | undefined;
    let cancellation: Promise<void> | undefined;
    let closing = false;
    let close = () => {};
    const cancel = () => { cancellation ??= task.stop(); close(); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        restoreDebug = suppressDebug(tui);
        close = () => { if (closing) return; closing = true; done(); };
        closeActive = close;
        screen = new ShellScreen("", {
          approve() {}, cancel, close, detach: close,
          manual: () => task.manual(),
          submit: (id, value) => { task.submit(id, value); if (automatic) close(); },
        }, () => tui.requestRender(), "", () => tui.terminal?.columns ?? 80, () => tui.terminal?.rows ?? 24, (role, text) => theme.fg?.(role, text) ?? text);
        screen.start(task.id);
        task.attach(event => {
          if (closing) return;
          if (event.type === "done") screen?.finish(task.status);
          else if (screen?.event(event) && event.type === "prompt") focused.set(task, event.id!);
        });
        if (!task.active) screen.finish(task.status);
        if (signal?.aborted) queueMicrotask(cancel);
        return screen;
      });
    } finally {
      closing = true;
      signal?.removeEventListener("abort", cancel);
      task.detach(); screen?.dispose(); restoreDebug?.(); closeActive = undefined;
      await cancellation;
    }
  }
  async function run(command: string, timeout: number | undefined, background: boolean, ctx: ExtensionContext, signal?: AbortSignal) {
    if (!available(ctx)) return statusResult("unavailable");
    if (logging()) return statusResult("logging-blocked");
    if (busy) return statusResult("busy");
    const seconds = timeout ?? Number(pi.getFlag("interactive-shell-timeout"));
    const lease = Number(pi.getFlag("interactive-shell-lease"));
    if (typeof command !== "string" || !command || command.length > 8192 || command.includes("\0") || !Number.isFinite(seconds) || seconds < 1 || seconds > 3600 || !Number.isFinite(lease) || lease < 1 || lease > 120) return statusResult("invalid-request");
    if (signal?.aborted) return statusResult("cancelled");
    busy = true;
    const owner = registry;
    let task: ShellTask | undefined;
    try {
      const heading = "Warning: command output reaches the model and transcript. Echoed credentials are exposed; no secret redaction.";
      if (!await approve(command, `${heading} ${background ? "Background session task" : "Foreground task"}; deadline ${seconds}s. No durable services.`, ctx, signal)) return statusResult("denied");
      if (signal?.aborted || registry !== owner || logging()) return statusResult("cancelled");
      let notified = false;
      task = owner.start(command, ctx.cwd, seconds, lease, (waiting, needsInput) => {
        if (!needsInput) { pending.delete(waiting.id); ctx.ui.setStatus?.(`shell-${waiting.id}`, undefined); return; }
        if (owner !== registry) return;
        const prompt = waiting.pendingPrompt();
        if (!prompt) return;
        ctx.ui.setStatus?.(`shell-${waiting.id}`, `Task ${waiting.id}: ${prompt.text} | /shell-attach ${waiting.id}`);
        if (focused.get(waiting) !== prompt.id) {
          pending.set(waiting.id, { task: waiting, generation: prompt.id, owner, ctx });
          queueMicrotask(drain);
        }
        if (notified) return;
        notified = true;
        ctx.ui.notify(`Waiting for your input. Task ${waiting.id}. Program-provided request: ${prompt.text}. Run /shell-attach ${waiting.id}. Runtime timeout includes prompt wait.`, "warning");
      });
      if (!task) return statusResult("task-limit");
      void task.done.then(() => ctx.ui.setStatus?.(`shell-${task!.id}`, undefined));
      if (!background) await focus(task, ctx, signal);
      return result(JSON.stringify(task.summary()) + `\nOutput:\n${task.read()}`);
    } catch {
      if (task) await task.stop();
      return statusResult("error");
    } finally { busy = false; drain(); }
  }
  const parameters = Type.Object({
    command: Type.String({ description: "Exact bash command. Never include credentials." }),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
    background: Type.Optional(Type.Boolean({ description: "Return task receipt immediately after approval; launch receipt is not readiness; pending prompts auto-open local masked input." })),
  });
  pi.registerTool({
    name: "interactive_shell", label: "Session shell", description: "Run exact command with local approval and masked TUI responses. Bounded output is returned. Background IDs confirm launch, not readiness. waiting-for-user includes a live program-provided prompt; masked input opens locally, or use /shell-attach ID. Never request secrets in chat. No durable services.", parameters,
    execute: async (_id, args, signal, _update, ctx) => run(args.command, args.timeout, args.background ?? false, ctx, signal),
  });
  pi.registerTool({
    name: "shell_task", label: "Shell task", description: "List, query, read bounded output, or stop session-owned tasks. Input requires local /shell-attach; never request secrets in chat.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("read"), Type.Literal("stop")]), id: Type.Optional(Type.String()) }),
    execute: async (_id, args) => {
      try {
        if (args.action === "list") return result(JSON.stringify(registry.list()));
        const task = registry.get(args.id ?? "");
        if (!task) return statusResult("not-found");
        if (args.action === "stop") await task.stop();
        return result(JSON.stringify(task.summary()) + `\nOutput:\n${task.read()}`);
      } catch { return statusResult("error"); }
    },
  });
  for (const [name, background] of [["shell", false], ["shell-bg", true]] as const) {
    pi.registerCommand(name, { description: `Approve ${background ? "background" : "foreground"} command`, handler: async (command, ctx) => {
      const response = await run(command, undefined, background, ctx, ctx.signal);
      // Do not copy visible command output to notifications.
      const text = response.content[0].text;
      ctx.ui.notify(text.startsWith("{") ? text.split("\n")[0] : text, "info");
    } });
  }
  pi.registerCommand("shell-tasks", { description: "List session task IDs and status without output", handler: async (_args, ctx) => {
    if (available(ctx)) ctx.ui.notify(JSON.stringify(registry.list()), "info");
  } });
  pi.registerCommand("shell-stop", { description: "Stop and reap a session task by ID", handler: async (id, ctx) => {
    if (!available(ctx)) return;
    const task = registry.get(id.trim());
    if (task) await task.stop();
    ctx.ui.notify(task ? `Shell task ${task.id}: ${task.status}` : "Shell task not found", "info");
  } });
  pi.registerCommand("shell-attach", { description: "Focus an existing session task; Ctrl+D detaches without stopping", handler: async (id, ctx) => {
    if (!available(ctx) || logging() || busy) return;
    const task = registry.get(id.trim());
    if (!task) { ctx.ui.notify("Shell task not found", "info"); return; }
    busy = true;
    ctx.ui.setStatus?.(`shell-${task.id}`, undefined);
    try { await focus(task, ctx); } catch { ctx.ui.notify("Shell screen unavailable", "error"); } finally { busy = false; drain(); }
  } });
  pi.on("session_start", async () => {
    pending.clear();
    closeActive?.();
    const previous = registry;
    registry = new TaskRegistry();
    const cleanup = previous.shutdown();
    if (pi.getFlag("interactive-shell-bash") === true) {
      const original = createBashTool(process.cwd());
      pi.registerTool({ name: "bash", label: "Interactive bash", description: "All bash calls require local TUI approval; bounded output and masked responses. Never put credentials in arguments.", parameters: original.parameters,
        execute: async (_id, args, signal, _update, ctx) => run(args.command, args.timeout, false, ctx, signal) });
    }
    await cleanup;
  });
  pi.on("session_shutdown", async () => {
    pending.clear();
    closeActive?.();
    const old = registry;
    registry = new TaskRegistry();
    await old.shutdown();
  });
}
