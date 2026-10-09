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
    f.screen.render(80); f.screen.handleInput("y");
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

test("detach discards masked input without cancelling; disposed screen rejects stale reply", () => {
  let detached = 0, cancelled = 0, submitted = 0;
  const screen = new PrivateScreen("", { approve() {}, cancel() { cancelled++; }, close() {}, manual() {}, submit() { submitted++; }, detach() { detached++; } }, () => {});
  screen.start();
  screen.event({ type: "prompt", id: 1, lease: 10 });
  screen.handleInput("synthetic-only");
  screen.handleInput("\x04");
  screen.handleInput("\r");
  screen.dispose();
  screen.event({ type: "prompt", id: 2, lease: 10 });
  screen.handleInput("synthetic-only"); screen.handleInput("\r");
  assert.equal(detached, 1); assert.equal(cancelled, 0); assert.equal(submitted, 0);
});

test("approval requires rendered pages, including after navigation and resize", () => {
  let approved = 0;
  const screen = new PrivateScreen("x".repeat(200), { approve() { approved++; }, cancel() {}, manual() {}, submit() {}, close() {} }, () => {});
  try {
    screen.handleInput("y"); assert.equal(approved, 0);
    screen.render(20);
    screen.handleInput("\x1b[C"); screen.handleInput("y"); assert.equal(approved, 0);
    screen.render(20);
    screen.invalidate(); screen.handleInput("y"); assert.equal(approved, 0);
    screen.render(10); screen.handleInput("y"); assert.equal(approved, 0);
    for (let i = 0; i < 4; i++) { screen.handleInput("\x1b[C"); screen.render(10); }
    screen.handleInput("y"); assert.equal(approved, 1);
  } finally { screen.dispose(); }
});

test("attached output shows identity, policy, echo warning, and inspectable offset pages", () => {
  const f = fixture();
  try {
    f.screen.start("synthetic-task", "visible");
    f.screen.event({ type: "output", text: "old-synthetic" + "x".repeat(600) + "new-synthetic" });
    const last = f.screen.render(80).join("\n");
    assert(last.includes("synthetic-task")); assert(last.includes("output: visible"));
    assert(last.includes("echoed credentials")); assert(last.includes("new-synthetic"));
    f.screen.handleInput("\x1b[5~"); f.screen.handleInput("\x1b[5~");
    const first = f.screen.render(80).join("\n");
    assert(first.includes("[0, 256)")); assert(first.includes("old-synthetic"));
  } finally { f.screen.dispose(); }
});

test("debug guard restores once and preserves a replacement callback", async () => {
  const { suppressDebug } = await import("../src/debug-guard.ts");
  const original = () => {}, replacement = () => {};
  const tui = { onDebug: original };
  const restore = suppressDebug(tui);
  assert.notEqual(tui.onDebug, original);
  restore(); restore(); assert.equal(tui.onDebug, original);
  const second = suppressDebug(tui);
  tui.onDebug = replacement; second(); assert.equal(tui.onDebug, replacement);
});

test("terminal resize rejects approval until a new width preview renders", () => {
  let width = 80, approved = false;
  const screen = new PrivateScreen("synthetic-only", { approve() { approved = true; }, cancel() {}, close() {}, manual() {}, submit() {} }, () => {}, "Review", () => width);
  try {
    screen.render(80); width = 40; screen.handleInput("y"); assert.equal(approved, false);
    screen.render(40); screen.handleInput("y"); assert.equal(approved, true);
  } finally { screen.dispose(); }
});
