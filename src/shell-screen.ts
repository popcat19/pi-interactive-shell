// Purpose: Display bounded PTY output and forward local input while a task runs.
import { decodeKittyPrintable, isKeyRelease, matchesKey, wrapTextWithAnsi, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";

export type ScreenActions = {
  input(data: string): void;
  cancel(): void;
  close(): void;
  detach(): void;
  resize(columns: number, rows: number): void;
};

export class ShellScreen {
  private disposed = false;
  private finished = false;
  private output = "";
  private identity = "Shell";
  private prompt = "";
  private outputPage = 0;
  private outputPages = 1;
  private followOutput = true;
  private dimensions = "";
  private actions: ScreenActions;
  private redraw: () => void;
  private currentHeight: () => number;
  private style: (role: "accent" | "warning", text: string) => string;
  constructor(actions: ScreenActions, redraw: () => void, currentHeight = () => 24, style: (role: "accent" | "warning", text: string) => string = (_role, text) => text) {
    this.actions = actions; this.redraw = redraw; this.currentHeight = currentHeight; this.style = style;
  }
  start(id: string) { this.identity = `Task ${id}`; }
  invalidate() {}
  event(event: { type: string; text?: string; id?: number }) {
    if (this.disposed || this.finished) return false;
    if (event.type === "output") {
      this.output = (this.output + (event.text ?? "").replace(/\r/g, "").replace(/[^\x20-\x7e\n]/g, " ")).slice(-16384);
      this.prompt = "";
    } else if (event.type === "prompt") {
      this.prompt = (event.text ?? "Input requested").replace(/[^\x20-\x7e]/g, " ").slice(-256);
    } else if (event.type === "invalidate" || event.type === "submitted") this.prompt = "";
    this.redraw();
    return event.type === "prompt";
  }
  finish(_status: string) {
    if (this.disposed || this.finished) return;
    this.finished = true;
    this.actions.close();
  }
  handleInput(data: string) {
    if (this.disposed || this.finished || isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) { this.actions.cancel(); return; }
    if (matchesKey(data, "ctrl+]")) { this.actions.detach(); return; }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.outputPage = Math.max(0, Math.min(this.outputPages - 1, this.outputPage + (matchesKey(data, "pageUp") ? -1 : 1)));
      this.followOutput = this.outputPage === this.outputPages - 1;
      this.redraw();
      return;
    }
    // Pi can deliver Kitty key encodings even though the child uses a plain PTY.
    const keys: [KeyId, string][] = [["enter", "\r"], ["backspace", "\x7f"], ["tab", "\t"], ["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"], ["home", "\x1b[H"], ["end", "\x1b[F"], ["delete", "\x1b[3~"]];
    for (let i = 1; i <= 26; i++) keys.push([`ctrl+${String.fromCharCode(96 + i)}` as KeyId, String.fromCharCode(i)]);
    const key = keys.find(([name]) => matchesKey(data, name));
    const value = key?.[1] ?? decodeKittyPrintable(data) ?? data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
    this.actions.input(value);
  }
  render(width: number): string[] {
    const w = Math.max(1, width), height = Math.max(1, this.currentHeight());
    const dimensions = `${w}:${height}`;
    if (dimensions !== this.dimensions) {
      this.dimensions = dimensions;
      this.actions.resize(w, height);
    }
    const limit = Math.max(1, height - 2);
    const wrap = (text: string) => wrapTextWithAnsi(text, w);
    const header = wrap(this.identity).map(line => this.style("accent", line));
    const request = this.prompt ? wrap(this.prompt).map(line => this.style("warning", line)) : [];
    const hints = wrap("Type anytime | Esc: stop | Ctrl+]: detach | PgUp/PgDn: output");
    const pageSize = Math.max(1, limit - header.length - request.length - hints.length - 1);
    const output = wrap(this.output || "(No output yet)");
    this.outputPages = Math.max(1, Math.ceil(output.length / pageSize));
    this.outputPage = this.followOutput ? this.outputPages - 1 : Math.min(this.outputPage, this.outputPages - 1);
    return [...header, ...request, ...output.slice(this.outputPage * pageSize, (this.outputPage + 1) * pageSize), `Output page ${this.outputPage + 1}/${this.outputPages}`, ...hints].slice(0, limit).map(line => truncateToWidth(line, w));
  }
  dispose() { this.disposed = true; this.output = ""; this.prompt = ""; }
}
