// Purpose: Render actionable approval, bounded output, and provisional masked input in Pi's TUI.
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
  detach?(): void;
};

export class ShellScreen {
  private phase: "approval" | "running" | "done" = "approval";
  private command: string;
  private page = 0;
  private pages = 1;
  private previewRendered = false;
  private previewWidth = 0;
  private reviewed = new Set<number>();
  private outputPage = 0;
  private followOutput = true;
  private identity = "Shell";
  private outputPages = 1;
  private previewHeight = 0;
  private currentHeight: () => number;
  private style: (role: "accent" | "warning" | "success", text: string) => string;
  private output = "";
  private secret = "";
  private prompt?: { id: number; deadline: number };
  private status = "Approval required";
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private actions: ScreenActions;
  private redraw: () => void;
  private heading: string;
  private currentWidth?: () => number;
  constructor(command: string, actions: ScreenActions, redraw: () => void, heading = "Command output is returned. Echoed credentials are exposed.", currentWidth?: () => number, currentHeight: () => number = () => 24, style: (role: "accent" | "warning" | "success", text: string) => string = (_role, text) => text) {
    this.currentWidth = currentWidth;
    this.currentHeight = currentHeight;
    this.style = style;
    this.heading = heading;
    this.actions = actions;
    this.redraw = redraw;
    this.command = escapedCommand(command);
    this.timer = setInterval(() => {
      if (this.prompt && performance.now() >= this.prompt.deadline) this.invalidatePrompt();
      this.redraw();
    }, 100);
  }
  start(id = "local") {
    this.phase = "running"; this.command = ""; this.status = "Running";
    this.identity = `Task ${id}`;
  }
  invalidate() { this.previewRendered = false; }
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
    if (this.phase === "running" && matchesKey(data, "ctrl+d") && this.actions.detach) {
      this.invalidatePrompt(); this.actions.detach(); return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.secret = "";
      if (this.phase === "done") this.actions.close();
      else this.actions.cancel();
      return;
    }
    if (this.phase === "approval") {
      if (data === "n" || data === "N" || matchesKey(data, "enter")) { this.actions.cancel(); return; }
      const previousPage = this.page;
      if (matchesKey(data, "right") || matchesKey(data, "pageDown") || data === " ") this.page = Math.min(this.pages - 1, this.page + 1);
      if (matchesKey(data, "left") || matchesKey(data, "pageUp")) this.page = Math.max(0, this.page - 1);
      if (previousPage !== this.page) this.previewRendered = false;
      if (data === "y" && this.previewRendered && (!this.currentWidth || this.currentWidth() === this.previewWidth) && this.previewHeight === this.currentHeight() && this.reviewed.size === this.pages && this.page === this.pages - 1) {
        this.phase = "running";
        this.command = "";
        this.status = "Running";
        this.actions.approve();
      }
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const count = this.outputPages;
      this.outputPage = Math.max(0, Math.min(count - 1, this.outputPage + (matchesKey(data, "pageUp") ? -1 : 1)));
      this.followOutput = this.outputPage === count - 1;
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
    const height = Math.max(1, this.currentHeight());
    const limit = Math.max(1, height - 2);
    const wrap = (text: string) => wrapTextWithAnsi(text, w);
    let lines: string[];
    if (this.phase === "approval") {
      if (this.previewWidth !== w || this.previewHeight !== height) {
        this.previewWidth = w; this.previewHeight = height; this.page = 0; this.reviewed.clear(); this.previewRendered = false;
      }
      const title = wrap(":: Run this command? [y/N]");
      const hints = wrap("Left/Right: review | y: run | Enter/Esc: deny");
      const content = [...wrap(this.heading), ...wrap("Exact command (JSON-escaped):"), ...wrap(this.command)];
      const pageSize = Math.max(1, limit - title.length - hints.length - 1);
      this.pages = Math.max(1, Math.ceil(content.length / pageSize));
      this.page = Math.min(this.page, this.pages - 1);
      if (title.length + hints.length + 2 > limit) {
        this.previewRendered = false;
        return wrap("Enlarge terminal to review. Esc: deny.").slice(0, limit);
      }
      this.reviewed.add(this.page); this.previewRendered = true;
      lines = [...title.map(line => this.style("accent", line)), ...content.slice(this.page * pageSize, (this.page + 1) * pageSize), `Review page ${this.page + 1}/${this.pages}`, ...hints];
    } else {
      const state = this.phase === "done" ? `:: ${this.status}` : this.prompt ? ":: Waiting for your input" : ":: Running";
      const header = [...wrap(state).map(line => this.style(this.prompt ? "warning" : "accent", line)), ...wrap(this.identity)];
      const response = this.prompt ? wrap(`Response (masked, ${Math.max(0, Math.ceil((this.prompt.deadline - performance.now()) / 1000))}s): ${"*".repeat(Math.min(60, Array.from(this.secret).length))}`) : [];
      const hints = wrap(this.phase === "done" ? "PgUp/PgDn: output | Enter/Esc: close" : this.prompt ? "Enter: send | Ctrl+U: clear | Ctrl+D: detach | Esc: stop | PgUp/PgDn: output" : "Ctrl+P: input | Ctrl+D: detach | Esc: stop | PgUp/PgDn: output");
      const pageSize = Math.max(1, limit - header.length - response.length - hints.length - 1);
      const outputLines = wrap(this.output || "(No output yet)");
      this.outputPages = Math.max(1, Math.ceil(outputLines.length / pageSize));
      this.outputPage = this.followOutput ? this.outputPages - 1 : Math.min(this.outputPage, this.outputPages - 1);
      if (header.length + response.length + hints.length + 2 > limit) {
        return [...wrap(state), ...wrap("Enlarge terminal. Ctrl+D: detach. Esc: stop.")].slice(0, limit);
      }
      lines = [...header, ...response, ...outputLines.slice(this.outputPage * pageSize, (this.outputPage + 1) * pageSize), `Output page ${this.outputPage + 1}/${this.outputPages}`, ...hints];
    }
    return lines.slice(0, limit).map(line => truncateToWidth(line, w));
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
