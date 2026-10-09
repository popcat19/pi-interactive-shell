// Purpose: Verify masked screen rendering, command escaping, and generation invalidation.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PrivateScreen, escapedCommand } from "../src/private-screen.ts";

function fixture() {
  const submitted: [number, string][] = [];
  let approvals = 0;
  const screen = new PrivateScreen("printf 'hello'", {
    approve() { approvals++; }, cancel() {}, manual() {}, close() {},
    submit(id, value) { submitted.push([id, value]); },
  }, () => {});
  return { screen, submitted, approvals: () => approvals };
}

test("approval displays reversible ASCII escaping", () => {
  const command = "printf '\u001b]52;bad\u0007'\n# \u202e日本";
  const escaped = escapedCommand(command);
  assert.equal(JSON.parse(escaped), command);
  assert.match(escaped, /^[\x20-\x7e]+$/);
});
test("mask secret and send once", () => {
  const f = fixture();
  try {
    f.screen.render(80); f.screen.handleInput("y");
    assert.equal(f.approvals(), 1);
    f.screen.event({ type: "prompt", id: 1, lease: 10 });
    f.screen.handleInput("synthetic-only");
    assert(!f.screen.render(80).join("\n").includes("synthetic-only"));
    f.screen.handleInput("\r"); f.screen.handleInput("\r");
    assert.deepEqual(f.submitted, [[1, "synthetic-only"]]);
  } finally { f.screen.dispose(); }
});
test("output, expiry, process completion discard provisional text", async () => {
  const f = fixture();
  try {
    f.screen.handleInput("y");
    f.screen.event({ type: "prompt", id: 1, lease: 10 });
    f.screen.handleInput("discard-me");
    f.screen.event({ type: "output", text: "changed\x1b[2J" });
    f.screen.handleInput("\r");
    f.screen.event({ type: "prompt", id: 2, lease: 0.001 });
    f.screen.handleInput("discard-too");
    await new Promise(r => setTimeout(r, 10));
    f.screen.handleInput("\r");
    f.screen.finish("completed");
    f.screen.handleInput("\r");
    assert.deepEqual(f.submitted, []);
    for (const width of [1, 8, 40, 80]) {
      assert(f.screen.render(width).every(line => visibleWidth(line) <= width && !line.includes("\x1b[2J")));
    }
  } finally { f.screen.dispose(); }
});
test("approval paging cannot accept before last page", () => {
  let approved = false;
  const screen = new PrivateScreen("x".repeat(1000), { approve() { approved = true; }, cancel() {}, manual() {}, submit() {}, close() {} }, () => {});
  try { screen.render(20); screen.handleInput("y"); assert.equal(approved, false); }
  finally { screen.dispose(); }
});
