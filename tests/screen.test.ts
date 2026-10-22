// Purpose: Verify interactive PTY screen input, rendering, and task lifecycle controls.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ShellScreen, type ScreenActions } from "../src/shell-screen.ts";

function fixture() {
  const input: string[] = [], cancelled: string[] = [], closed: string[] = [], detached: string[] = [], sizes: number[][] = [];
  const screen = new ShellScreen({ input: value => input.push(value), cancel: () => cancelled.push("stop"), close: () => closed.push("close"), detach: () => detached.push("detach"), resize: (columns, rows) => sizes.push([columns, rows]) }, () => {});
  screen.start("test-task");
  return { screen, input, cancelled, closed, detached, sizes };
}

test("input is always forwarded without a detected prompt", () => {
  const f = fixture();
  try {
    f.screen.handleInput("ssh login"); f.screen.handleInput("\r"); f.screen.handleInput("synthetic-password"); f.screen.handleInput("\r");
    assert.deepEqual(f.input, ["ssh login", "\r", "synthetic-password", "\r"]);
  } finally { f.screen.dispose(); }
});

test("terminal controls pass through and Esc stops while Ctrl+] detaches", () => {
  const f = fixture();
  try {
    f.screen.handleInput("\x03"); f.screen.handleInput("\x04");
    assert.deepEqual(f.input, ["\x03", "\x04"]);
    f.screen.handleInput("\x1b"); f.screen.handleInput("\x1d");
    assert.deepEqual(f.cancelled, ["stop"]); assert.deepEqual(f.detached, ["detach"]);
  } finally { f.screen.dispose(); }
});

test("output strips carriage-return artifacts and retains exact printable text", () => {
  const f = fixture();
  try {
    f.screen.event({ type: "output", text: "line one\r\nline two\r\n" });
    const output = f.screen.render(80).join("\n");
    assert(output.includes("line one\nline two\n")); assert(!output.includes("?"));
  } finally { f.screen.dispose(); }
});

test("SSH prompt context is shown without gating input", () => {
  const f = fixture();
  try {
    f.screen.event({ type: "prompt", id: 1, text: "Password for host:" });
    assert(f.screen.render(80).join("\n").includes("Password for host:"));
    f.screen.handleInput("synthetic-secret"); f.screen.handleInput("\r");
    assert.deepEqual(f.input, ["synthetic-secret", "\r"]);
  } finally { f.screen.dispose(); }
});

test("completion closes without an acknowledgement key", () => {
  const f = fixture();
  try {
    f.screen.finish("completed"); f.screen.handleInput("\r");
    assert.deepEqual(f.closed, ["close"]); assert.deepEqual(f.input, []);
  } finally { f.screen.dispose(); }
});

test("resize dimensions are sent to the child PTY and rendering stays bounded", () => {
  const f = fixture();
  try {
    f.screen.render(40); f.screen.render(40); f.screen.render(20);
    assert.deepEqual(f.sizes, [[40, 24], [20, 24]]);
    f.screen.event({ type: "output", text: Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n") });
    for (const width of [1, 10, 40, 80]) assert(f.screen.render(width).every(line => visibleWidth(line) <= width));
    for (let i = 0; i < 100; i++) f.screen.handleInput("\x1b[5~"); assert(f.screen.render(80).join("\n").includes("line-0"));
  } finally { f.screen.dispose(); }
});

test("keyboard mappings preserve SSH control keys and CR-free output", () => {
  const f = fixture();
  try {
    f.screen.handleInput("\x1b[A"); f.screen.handleInput("\x1b[3~");
    assert.deepEqual(f.input, ["\x1b[A", "\x1b[3~"]);
    f.screen.event({ type: "output", text: "synthetic\r\n" });
    assert(!f.screen.render(80).join("\n").includes("synthetic?"));
  } finally { f.screen.dispose(); }
});
