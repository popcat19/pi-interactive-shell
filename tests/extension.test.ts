// Purpose: Check registration, opt-in routing, and fail-closed behavior without credentials.
import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/extension.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

function fixture(enabled = false) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, () => void>();
  const flags = new Map<string, string | boolean>();
  const api = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerFlag(name: string, options: { default: string | boolean }) { flags.set(name, options.default); },
    getFlag(name: string) { return flags.get(name); },
    on(name: string, handler: () => void) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  extension(api);
  flags.set("interactive-shell-bash", enabled);
  handlers.get("session_start")!();
  return { tools };
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
