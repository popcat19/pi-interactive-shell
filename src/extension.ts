// Purpose: Gate session PTY tasks and output release behind local TUI approval.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { suppressDebug } from "./debug-guard.ts";
import { PrivateScreen } from "./private-screen.ts";
import { TaskRegistry, type ShellTask, type OutputPolicy } from "./task-registry.ts";

const LOGGING = ["PI_TUI_WRITE_LOG", "PI_TUI_DEBUG", "PI_TUI_DEBUG_REDRAW"];
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const statusResult = (status: string) => result(`Private shell status: ${status}. Output and responses withheld.`);
export default function extension(pi: ExtensionAPI) {
  let registry = new TaskRegistry();
  let busy = false;
  let closeActive: (() => void) | undefined;
  pi.registerFlag("interactive-shell-bash", { type: "boolean", default: false, description: "Require approval and privately broker ALL agent bash calls" });
  pi.registerFlag("interactive-shell-timeout", { type: "string", default: "300", description: "Task deadline in seconds, 1..3600" });
  pi.registerFlag("interactive-shell-lease", { type: "string", default: "30", description: "Masked prompt lease in seconds, 1..120" });
  const available = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI && process.stdin.isTTY && process.stdout.isTTY && process.platform === "linux";
  const logging = () => LOGGING.some(key => Boolean(process.env[key]));
  async function approve(text: string, heading: string, ctx: ExtensionContext, signal?: AbortSignal) {
    let restoreDebug: (() => void) | undefined;
    let screen: PrivateScreen | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
        restoreDebug = suppressDebug(tui);
        cancel = () => done(false);
        closeActive = cancel;
        screen = new PrivateScreen(text, { approve: () => done(!signal?.aborted && !logging()), cancel, close: cancel, manual() {}, submit() {} }, () => tui.requestRender(), heading, () => tui.terminal?.columns ?? 0);
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
  async function focus(task: ShellTask, ctx: ExtensionContext, signal?: AbortSignal) {
    let restoreDebug: (() => void) | undefined;
    let screen: PrivateScreen | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => { cancellation ??= task.stop(); closeActive?.(); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        restoreDebug = suppressDebug(tui);
        closeActive = () => done();
        screen = new PrivateScreen("", { approve() {}, cancel, close: done, detach: done, manual: () => task.manual(), submit: (id, value) => task.submit(id, value) }, () => tui.requestRender());
        screen.start(task.id, task.policy);
        const finish = () => { screen?.finish(task.status); timer ??= setTimeout(done, 10000); };
        task.attach(event => { if (event.type === "done") finish(); else screen?.event(event); });
        if (!task.active) finish();
        if (signal?.aborted) queueMicrotask(cancel);
        return screen;
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
      task.detach(); screen?.dispose(); clearTimeout(timer); restoreDebug?.(); closeActive = undefined;
      await cancellation;
    }
  }
  async function run(command: string, timeout: number | undefined, background: boolean, policy: OutputPolicy, ctx: ExtensionContext, signal?: AbortSignal) {
    if (!available(ctx)) return statusResult("unavailable");
    if (logging()) return statusResult("logging-blocked");
    if (busy) return statusResult("busy");
    const seconds = timeout ?? Number(pi.getFlag("interactive-shell-timeout"));
    const lease = Number(pi.getFlag("interactive-shell-lease"));
    if (typeof command !== "string" || !command || command.length > 8192 || command.includes("\0") || !Number.isFinite(seconds) || seconds < 1 || seconds > 3600 || !Number.isFinite(lease) || lease < 1 || lease > 120 || !["private", "visible"].includes(policy)) return statusResult("invalid-request");
    if (signal?.aborted) return statusResult("cancelled");
    busy = true;
    const owner = registry;
    let task: ShellTask | undefined;
    try {
      const heading = policy === "visible"
        ? "OUTPUT-VISIBLE APPROVAL: exact bash command below. WARNING: programs can echo credentials, including masked responses. ALL captured output can reach the model and session transcript. y approves this sharing policy."
        : "PRIVATE APPROVAL: exact bash command below. Output stays private unless selected and released locally.";
      if (!await approve(command, `${heading} ${background ? "Background session task" : "Foreground task"}; deadline ${seconds}s. No durable services.`, ctx, signal)) return statusResult("denied");
      if (signal?.aborted || registry !== owner || logging()) return statusResult("cancelled");
      task = owner.start(command, ctx.cwd, seconds, lease, policy);
      if (!task) return statusResult("task-limit");
      if (!background) await focus(task, ctx, signal);
      return result(JSON.stringify(task.summary()) + (policy === "visible" ? `\nApproved output:\n${task.read()}` : "\nOutput and responses withheld. Use shell_task to query status."));
    } catch {
      if (task) await task.stop();
      return statusResult("error");
    } finally { busy = false; }
  }
  const parameters = Type.Object({
    command: Type.String({ description: "Exact bash command. Never include credentials." }),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
    background: Type.Optional(Type.Boolean({ description: "Return task receipt immediately after approval; never auto-focus prompts." })),
    output: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("visible")], { description: "Private by default. Visible requires separate explicit echo-risk approval before execution." })),
  });
  pi.registerTool({
    name: "interactive_shell", label: "Session shell", description: "Run exact command with local approval and masked TUI responses. Private by default. Background jobs return IDs; waiting-for-user requires local /shell-attach ID. Never request secrets in chat. No durable services.", parameters,
    execute: async (_id, args, signal, _update, ctx) => run(args.command, args.timeout, args.background ?? false, args.output ?? "private", ctx, signal),
  });
  pi.registerTool({
    name: "shell_task", label: "Shell task", description: "List, query, read policy-approved bounded output, or stop session-owned tasks. Cannot attach, enter secrets, release private output, or change sharing policy.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("read"), Type.Literal("stop")]), id: Type.Optional(Type.String()) }),
    execute: async (_id, args) => {
      try {
        if (args.action === "list") return result(JSON.stringify(registry.list()));
        const task = registry.get(args.id ?? "");
        if (!task) return statusResult("not-found");
        if (args.action === "stop") await task.stop();
        return result(JSON.stringify(task.summary()) + (args.action === "read" ? `\nApproved output:\n${task.read()}` : ""));
      } catch { return statusResult("error"); }
    },
  });
  for (const [name, background, policy] of [["shell", false, "private"], ["shell-bg", true, "private"], ["shell-visible", false, "visible"], ["shell-bg-visible", true, "visible"]] as const) {
    pi.registerCommand(name, { description: `Approve ${policy} ${background ? "background" : "foreground"} command`, handler: async (command, ctx) => {
      const response = await run(command, undefined, background, policy, ctx, ctx.signal);
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
    try { await focus(task, ctx); } catch { ctx.ui.notify("Shell screen unavailable", "error"); } finally { busy = false; }
  } });
  pi.registerCommand("shell-release", { description: "Release selected private output: ID START END (character offsets, max 4096); preview first", handler: async (args, ctx) => {
    if (!available(ctx) || logging() || busy) return;
    const [id, startText, endText, extra] = args.trim().split(/\s+/);
    const task = registry.get(id);
    if (!task || task.policy !== "private") return;
    const snapshot = task.snapshot();
    const start = Number(startText), end = Number(endText);
    if (extra || !/^\d+$/.test(startText ?? "") || !/^\d+$/.test(endText ?? "") || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > snapshot.length || end - start > 4096) {
      ctx.ui.notify(`Use /shell-release ID START END. Current retained output: ${snapshot.length} characters; end exclusive, max 4096. Inspect via /shell-attach ID.`, "info"); return;
    }
    const selected = snapshot.slice(start, end);
    busy = true;
    const owner = registry;
    try {
      if (await approve(selected, "RELEASE EXACT SELECTED OUTPUT to model and session transcript. JSON-escaped preview below; no other output is released. Esc denies.", ctx) && owner === registry && owner.get(id) === task && !logging()) {
        task.release(selected);
        ctx.ui.notify("Selected output approved. shell_task read can retrieve it.", "info");
      }
    } catch { ctx.ui.notify("Output release cancelled", "info"); } finally { busy = false; }
  } });
  pi.on("session_start", async () => {
    closeActive?.();
    const previous = registry;
    registry = new TaskRegistry();
    const cleanup = previous.shutdown();
    if (pi.getFlag("interactive-shell-bash") === true) {
      const original = createBashTool(process.cwd());
      pi.registerTool({ name: "bash", label: "Private bash", description: "All bash calls require local TUI approval; private output and masked responses. Never put credentials in arguments.", parameters: original.parameters,
        execute: async (_id, args, signal, _update, ctx) => run(args.command, args.timeout, false, "private", ctx, signal) });
    }
    await cleanup;
  });
  pi.on("session_shutdown", async () => {
    closeActive?.();
    const old = registry;
    registry = new TaskRegistry();
    await old.shutdown();
  });
}
