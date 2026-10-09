// Purpose: Own bounded session PTY tasks independently of transient input screens.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export type TaskEvent = { type: string; text?: string; id?: number; lease?: number };
const terminal = new Set(["completed", "failed", "cancelled", "timeout", "error"]);
const brokerPath = fileURLToPath(new URL("../broker/pty-broker.py", import.meta.url));
export class ShellTask {
  readonly id = randomUUID();
  status = "running";
  exitCode?: number;
  endedAt?: number;
  private output = "";
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private listener?: (event: TaskEvent) => void;
  private prompt?: { id: number; deadline: number; text: string };
  private deadline?: ReturnType<typeof setTimeout>;
  private escalation?: ReturnType<typeof setTimeout>;
  private resolve!: () => void;
  readonly done: Promise<void>;
  private onWaiting?: (task: ShellTask, waiting: boolean) => void;
  private waitingHint = false;
  private promptTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private closed = false;
  constructor(command: string, cwd: string, timeout: number, lease: number, onWaiting?: (task: ShellTask, waiting: boolean) => void) {
    this.onWaiting = onWaiting;
    this.done = new Promise(resolve => { this.resolve = resolve; });
    try {
      const child = this.child = spawn("python3", ["-I", "-B", brokerPath], { cwd, stdio: "pipe" });
      child.stdin.on("error", () => {});
      child.stderr.on("data", () => {});
      child.on("error", () => { this.status = "error"; });
      child.on("close", () => this.finish());
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => this.receive(data));
      this.send({ command, cwd, timeout, lease });
      this.deadline = setTimeout(() => this.stop("timeout"), (timeout + 2) * 1000);
    } catch { this.status = "error"; this.finish(); }
  }
  get active() { return !this.closed; }
  private send(message: object) {
    if (this.closed || !this.child || this.child.stdin.destroyed) return;
    if (this.child.stdin.writableLength > 32768) { this.stop(); return; }
    this.child.stdin.write(JSON.stringify(message) + "\n", () => {});
  }
  private receive(data: string) {
    if (this.closed || this.stopping) return;
    this.buffer += data;
    if (this.buffer.length > 262144) { this.stop("error"); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "done") {
          this.status = terminal.has(event.status) ? event.status : "error";
          if (Number.isInteger(event.exitCode) && event.exitCode >= -64 && event.exitCode <= 255) this.exitCode = event.exitCode;
          this.invalidate();
        } else if (event.type === "output" && typeof event.text === "string") {
          this.invalidate();
          const text = event.text.replace(/[^\x20-\x7e\n]/g, "?");
          this.output = (this.output + text).slice(-16384);
          this.listener?.({ type: "output", text });
        } else if (event.type === "prompt" && Number.isSafeInteger(event.id) && Number.isFinite(event.lease) && event.lease > 0 && event.lease <= 120) {
          this.prompt = { id: event.id, deadline: performance.now() + event.lease * 1000, text: typeof event.text === "string" ? event.text.replace(/[^\x20-\x7e]/g, " ").trim().slice(-256) || "Input requested (prompt text unavailable)" : "Input requested (prompt text unavailable)" };
          this.status = "waiting-for-user";
          clearTimeout(this.promptTimer);
          this.promptTimer = setTimeout(() => this.invalidate(), event.lease * 1000);
          this.updateWaiting();
          this.listener?.({ type: "prompt", id: event.id, lease: event.lease, text: this.prompt.text });
        } else if (event.type === "invalidate" || event.type === "submitted") this.invalidate();
      } catch { this.stop("error"); return; }
    }
  }
  private updateWaiting() {
    const waiting = Boolean(this.active && !this.stopping && !this.listener && this.prompt && this.prompt.deadline > performance.now());
    if (waiting === this.waitingHint) return;
    this.waitingHint = waiting;
    this.onWaiting?.(this, waiting);
  }
  private invalidate() {
    clearTimeout(this.promptTimer);
    this.prompt = undefined;
    this.updateWaiting();
    if (this.status === "waiting-for-user") this.status = "running";
    this.listener?.({ type: "invalidate" });
  }
  attach(listener: (event: TaskEvent) => void) {
    if (this.listener) return false;
    this.listener = listener;
    this.updateWaiting();
    listener({ type: "output", text: this.output });
    // Reconnect never extends an existing generation's lease.
    if (this.prompt && this.prompt.deadline > performance.now()) listener({ type: "prompt", id: this.prompt.id, lease: (this.prompt.deadline - performance.now()) / 1000, text: this.prompt.text });
    return true;
  }
  detach() {
    this.listener = undefined;
    this.updateWaiting();
  }
  manual() { if (this.active && !this.stopping && this.listener) this.send({ type: "manual" }); }
  submit(id: number, value: string) {
    const prompt = this.prompt;
    this.invalidate();
    if (!this.listener || !this.active || this.stopping || !prompt || prompt.id !== id || prompt.deadline <= performance.now()) return;
    this.send({ type: "input", id, value });
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    if (!terminal.has(this.status)) this.status = "error";
    this.invalidate();
    this.endedAt = Date.now();
    clearTimeout(this.deadline); clearTimeout(this.escalation);
    this.buffer = "";
    this.listener?.({ type: "done" });
    this.resolve();
  }
  stop(status = "cancelled") {
    if (this.closed || this.stopping) return this.done;
    this.stopping = true;
    this.status = status;
    this.invalidate();
    this.child?.kill("SIGTERM");
    this.escalation = setTimeout(() => this.child?.kill("SIGKILL"), 1500);
    return this.done;
  }
  pendingPrompt() {
    if (this.prompt && this.prompt.deadline <= performance.now()) this.invalidate();
    return this.prompt ? { ...this.prompt } : undefined;
  }
  read() { return this.output; }
  summary() {
    if (this.prompt && this.prompt.deadline <= performance.now()) this.invalidate();
    return { id: this.id, status: this.status, prompt: this.prompt?.text, exitCode: this.exitCode, attach: `/shell-attach ${this.id}` };
  }
  erase() { this.output = ""; this.buffer = ""; this.detach(); }
}
export class TaskRegistry {
  private tasks = new Map<string, ShellTask>();
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private prune() {
    for (const [id, task] of this.tasks) if (!task.active && Date.now() - task.endedAt! >= 600000) { task.erase(); this.tasks.delete(id); }
  }
  start(command: string, cwd: string, timeout: number, lease: number, onWaiting?: (task: ShellTask, waiting: boolean) => void) {
    this.prune();
    if (this.closed || [...this.tasks.values()].filter(t => t.active).length >= 8) return undefined;
    if (this.tasks.size >= 16) {
      const oldest = [...this.tasks.values()].find(t => !t.active);
      if (!oldest) return undefined;
      oldest.erase(); this.tasks.delete(oldest.id);
    }
    this.timer ??= setInterval(() => this.prune(), 1000).unref();
    const task = new ShellTask(command, cwd, timeout, lease, onWaiting);
    this.tasks.set(task.id, task);
    return task;
  }
  get(id: string) { this.prune(); return this.tasks.get(id); }
  list() { this.prune(); return [...this.tasks.values()].map(t => t.summary()); }
  async shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.tasks.values()].map(t => t.stop()));
    for (const task of this.tasks.values()) task.erase();
    this.tasks.clear();
  }
}
