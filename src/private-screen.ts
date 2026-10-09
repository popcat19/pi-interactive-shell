// Purpose: Render private approval, bounded output, and provisional masked input in Pi's TUI.
import { decodeKittyPrintable, isKeyRelease, matchesKey, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";

export function escapedCommand(command: string): string {
  return JSON.stringify(command).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export type ScreenActions = {
  approve(): void;
  cancel(): void;
  manual(): void;
  submit(id: number, value: string): void;
  close(): void;
};

export class PrivateScreen {
  private phase: "approval" | "running" | "done" = "approval";
  private command: string;
  private page = 0;
  private pages = 1;
  private output = "";
  private secret = "";
  private prompt?: { id: number; deadline: number };
  private status = "Approval required";
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private actions: ScreenActions;
  private redraw: () => void;
  constructor(command: string, actions: ScreenActions, redraw: () => void) {
    this.actions = actions;
    this.redraw = redraw;
    this.command = escapedCommand(command);
    this.timer = setInterval(() => {
      if (this.prompt && performance.now() >= this.prompt.deadline) this.invalidatePrompt();
      this.redraw();
    }, 100);
  }
  invalidate() {}
  invalidatePrompt() {
    this.secret = "";
    this.prompt = undefined;
    this.redraw();
  }
  event(event: { type: string; text?: string; id?: number; lease?: number; status?: string }) {
    if (this.disposed) return;
    if (event.type === "output") {
      this.invalidatePrompt();
      // ASCII-only second boundary rejects terminal controls even if the broker is faulty.
      const text = (event.text ?? "").replace(/[^\x20-\x7e\n]/g, "?");
      this.output = (this.output + text).slice(-16384);
    } else if (event.type === "prompt" && Number.isSafeInteger(event.id) && Number.isFinite(event.lease)) {
      this.invalidatePrompt();
      this.prompt = { id: event.id!, deadline: performance.now() + event.lease! * 1000 };
    } else if (event.type === "invalidate" || event.type === "submitted") {
      this.invalidatePrompt();
    }
    this.redraw();
  }
  finish(status: string) {
    this.invalidatePrompt();
    this.phase = "done";
    this.status = status;
    this.redraw();
  }
  handleInput(data: string) {
    if (this.disposed || isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.secret = "";
      if (this.phase === "done") this.actions.close();
      else this.actions.cancel();
      return;
    }
    if (this.phase === "approval") {
      if (matchesKey(data, "right") || matchesKey(data, "pageDown") || data === " ") this.page = Math.min(this.pages - 1, this.page + 1);
      if (matchesKey(data, "left") || matchesKey(data, "pageUp")) this.page = Math.max(0, this.page - 1);
      if (data === "y" && this.page === this.pages - 1) {
        this.phase = "running";
        this.command = "";
        this.status = "Running privately";
        this.actions.approve();
      }
    } else if (this.phase === "done") {
      if (matchesKey(data, "enter")) this.actions.close();
    } else if (matchesKey(data, "ctrl+p")) {
      this.invalidatePrompt();
      this.actions.manual();
    } else if (this.prompt) {
      if (performance.now() >= this.prompt.deadline) this.invalidatePrompt();
      else if (matchesKey(data, "enter")) {
        const { id } = this.prompt;
        const value = this.secret;
        this.invalidatePrompt();
        this.actions.submit(id, value);
      } else if (matchesKey(data, "backspace")) this.secret = Array.from(this.secret).slice(0, -1).join("");
      else if (matchesKey(data, "ctrl+u")) this.secret = "";
      else {
        const text = decodeKittyPrintable(data) ?? data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
        if (!/[\x00-\x1f\x7f-\x9f]/.test(text) && Buffer.byteLength(this.secret + text) <= 1024) this.secret += text;
      }
    }
    this.redraw();
  }
  render(width: number): string[] {
    const w = Math.max(1, width);
    let lines: string[];
    if (this.phase === "approval") {
      const commandLines = wrapTextWithAnsi(this.command, w);
      this.pages = Math.max(1, Math.ceil(commandLines.length / 8));
      this.page = Math.min(this.page, this.pages - 1);
      lines = ["PRIVATE SHELL: approve exact JSON-escaped command", "bash --noprofile --norc -c <decoded command>", ...commandLines.slice(this.page * 8, this.page * 8 + 8), `Page ${this.page + 1}/${this.pages}. Left/right: review. y on last page: approve. Esc: deny.`, "Never put credentials in commands. Input is masked, not isolated."];
    } else {
      lines = ["PRIVATE SHELL: output never returned to the model", ...wrapTextWithAnsi(this.output, w).slice(-10), this.status];
      if (this.phase === "done") lines.push("Enter: close. Auto-close in 10 seconds.");
      else if (this.prompt) lines.push(`Response ${this.prompt.id}, lease ${Math.max(0, Math.ceil((this.prompt.deadline - performance.now()) / 1000))}s: ${"*".repeat(Math.min(60, Array.from(this.secret).length))}`, "Enter: send once. Ctrl+U: clear. Esc: cancel run.");
      else lines.push("Ctrl+P: manually open masked response. Esc: cancel run.");
      lines.push("Program timers keep running. Prompt leases do not prove read readiness.");
    }
    return lines.map(line => truncateToWidth(line, w));
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.secret = "";
    this.output = "";
    this.command = "";
    this.prompt = undefined;
  }
}
