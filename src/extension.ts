// Purpose: Gate private PTY runs behind TUI approval and optional agent bash replacement.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PrivateScreen } from "./private-screen.ts";

const STATUSES = new Set(["completed", "failed", "cancelled", "timeout", "error"]);
const LOGGING = ["PI_TUI_WRITE_LOG", "PI_TUI_DEBUG", "PI_TUI_DEBUG_REDRAW"];
const brokerPath = fileURLToPath(new URL("../broker/pty-broker.py", import.meta.url));

export default function extension(pi: ExtensionAPI) {
  let busy = false;
  let cancelActive: (() => void) | undefined;
  pi.registerFlag("interactive-shell-bash", { type: "boolean", default: false, description: "Require approval and privately broker ALL agent bash calls" });
  pi.registerFlag("interactive-shell-timeout", { type: "string", default: "300", description: "Private run deadline in seconds, 1..3600" });
  pi.registerFlag("interactive-shell-lease", { type: "string", default: "30", description: "Masked prompt lease in seconds, 1..120" });

  async function run(command: string, timeout: number | undefined, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
    if (ctx.mode !== "tui" || !ctx.hasUI || !process.stdin.isTTY || !process.stdout.isTTY || process.platform !== "linux") return "unavailable";
    if (LOGGING.some(key => Boolean(process.env[key]))) return "logging-blocked";
    if (busy) return "busy";
    const seconds = timeout ?? Number(pi.getFlag("interactive-shell-timeout"));
    const lease = Number(pi.getFlag("interactive-shell-lease"));
    if (!command || command.length > 8192 || command.includes("\0") || !Number.isFinite(seconds) || seconds < 1 || seconds > 3600 || !Number.isFinite(lease) || lease < 1 || lease > 120) return "invalid-request";
    if (signal?.aborted) return "cancelled";
    busy = true;
    let child: ChildProcessWithoutNullStreams | undefined;
    let screen: PrivateScreen | undefined;
    let closeUI: (() => void) | undefined;
    let status = "denied";
    let completed = false;
    let buffer = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let approvalTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (message: object) => {
      if (!child || child.stdin.destroyed || completed) return;
      const serialized = JSON.stringify(message) + "\n";
      if (child.stdin.writableLength > 32768) { cancel(); return; }
      child.stdin.write(serialized, () => {});
    };
    const finish = (next: string) => {
      if (completed) return;
      completed = true;
      status = next;
      screen?.finish(next);
      clearTimeout(deadlineTimer);
      closeTimer = setTimeout(() => closeUI?.(), 10000);
    };
    const cancel = () => {
      if (completed) { closeUI?.(); return; }
      status = child ? "cancelled" : "denied";
      if (!child) { completed = true; closeUI?.(); return; }
      send({ type: "cancel" });
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { child?.kill("SIGKILL"); finish("cancelled"); closeUI?.(); }, 1500);
    };
    cancelActive = cancel;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        closeUI = () => done();
        screen = new PrivateScreen(command, {
          approve() {
            clearTimeout(approvalTimer);
            if (signal?.aborted || LOGGING.some(key => Boolean(process.env[key]))) { cancel(); return; }
            status = "error";
            try {
              child = spawn("python3", ["-I", "-B", brokerPath], { cwd: ctx.cwd, stdio: "pipe" });
              child.stdin.on("error", () => {});
              child.stderr.on("data", () => {});
              child.on("error", () => finish("error"));
              child.on("close", () => { clearTimeout(killTimer); finish(status); });
              child.stdout.setEncoding("utf8");
              child.stdout.on("data", (data: string) => {
                if (completed) return;
                buffer += data;
                if (buffer.length > 262144) { cancel(); return; }
                let newline: number;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, newline);
                  buffer = buffer.slice(newline + 1);
                  try {
                    const event = JSON.parse(line);
                    if (event.type === "done") {
                      status = STATUSES.has(event.status) ? event.status : "error";
                      if (Number.isInteger(event.exitCode) && event.exitCode >= -64 && event.exitCode <= 255) status += ` (exit ${event.exitCode})`;
                    }
                    else screen?.event(event);
                  } catch { cancel(); return; }
                }
              });
              send({ command, cwd: ctx.cwd, timeout: seconds, lease });
              deadlineTimer = setTimeout(cancel, (seconds + 2) * 1000);
            } catch { finish("error"); }
          },
          cancel,
          manual: () => send({ type: "manual" }),
          submit: (id, value) => send({ type: "input", id, value }),
          close: () => closeUI?.(),
        }, () => tui.requestRender());
        approvalTimer = setTimeout(cancel, 60000);
        if (signal?.aborted) queueMicrotask(cancel);
        return screen;
      });
      return status;
    } catch {
      return "error";
    } finally {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(approvalTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(closeTimer);
      screen?.dispose();
      buffer = "";
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child?.kill("SIGKILL"); resolve(); }, 1500);
          child!.once("close", () => { clearTimeout(timer); resolve(); });
        });
      }
      clearTimeout(killTimer);
      cancelActive = undefined;
      busy = false;
    }
  }
  const result = (status: string) => ({ content: [{ type: "text" as const, text: `Private shell status: ${status}. Output and responses withheld.` }], details: undefined });
  const parameters = Type.Object({ command: Type.String({ description: "Exact bash command. Never include credentials." }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "Run deadline in seconds" })) });
  pi.registerTool({
    name: "interactive_shell", label: "Private shell", description: "Run an exact command through a private PTY with explicit human approval and masked responses. Requires Linux Pi TUI. Returns status only; do not request credentials in chat.", parameters,
    execute: async (_id, args, signal, _update, ctx) => result(await run(args.command, args.timeout, ctx, signal)),
  });
  pi.registerCommand("shell", {
    description: "Approve and run a command privately with PTY prompt input",
    handler: async (command, ctx) => { const status = await run(command, undefined, ctx, ctx.signal); ctx.ui.notify(`Private shell status: ${status}`, "info"); },
  });
  pi.on("session_start", () => {
    // CLI flag values are populated after factory loading. Registration refreshes active tools.
    if (pi.getFlag("interactive-shell-bash") === true) {
      const original = createBashTool(process.cwd());
      pi.registerTool({
        name: "bash", label: "Private bash", description: "All bash calls require human approval in the Linux TUI. Output and responses are private. Returns status only. Never put credentials in command arguments.",
        parameters: original.parameters,
        execute: async (_id, args, signal, _update, ctx) => result(await run(args.command, args.timeout, ctx, signal)),
      });
    }
  });
  pi.on("session_shutdown", () => { cancelActive?.(); });
}
