// Purpose: Verify bounded task ownership, bounded output, prompt generations, and process cleanup.
import assert from "node:assert/strict";
import test from "node:test";
import { TaskRegistry } from "../src/task-registry.ts";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("output returned by default; registry ownership and shutdown erase it", async () => {
  const owner = new TaskRegistry(), other = new TaskRegistry();
  try {
    const task = owner.start("printf synthetic-only", "/tmp", 3, 1)!;
    await task.done;
    assert.equal(task.status, "completed");
    assert.equal(task.read(), "synthetic-only");
    assert.equal(task.read(), "synthetic-only");
    assert(!JSON.stringify(owner.list()).includes("synthetic-only"));
    assert.equal(other.get(task.id), undefined);
    await owner.shutdown();
    assert.equal(task.read(), ""); assert.equal(task.read(), "");
    assert.equal(owner.start("true", "/tmp", 3, 1), undefined);
  } finally { await owner.shutdown(); await other.shutdown(); }
});
test("visible logs and flood stay bounded; history capped at sixteen", async () => {
  const registry = new TaskRegistry();
  try {
    const task = registry.start("head -c 100000 /dev/zero; printf synthetic-only", "/tmp", 3, 1)!;
    await task.done;
    assert.equal(task.read().length, 16384);
    assert(task.read().endsWith("synthetic-only"));
    for (let n = 0; n < 17; n++) await registry.start("true", "/tmp", 3, 1)!.done;
    assert.equal(registry.list().length, 16);
    assert.equal(task.read(), "");
  } finally { await registry.shutdown(); }
});
test("task limit, repeated stop, deadline, and shutdown reap active brokers", async () => {
  const registry = new TaskRegistry();
  const tasks = Array.from({ length: 8 }, () => registry.start("sleep 30", "/tmp", 3, 1)!);
  try {
    assert.equal(registry.start("true", "/tmp", 3, 1), undefined);
    await Promise.all([tasks[0].stop(), tasks[0].stop()]);
    assert.equal(tasks[0].status, "cancelled");
    const timed = registry.start("sleep 30", "/tmp", 0.2, 1)!;
    await timed.done; assert.equal(timed.status, "timeout");
    await registry.shutdown();
    assert(tasks.every(t => !t.active)); assert.deepEqual(registry.list(), []);
  } finally { await registry.shutdown(); }
});
test("background prompts never focus; attach preserves lease and stale generations cannot submit", async () => {
  const registry = new TaskRegistry();
  try {
    const task = registry.start("stty -echo; printf 'Password: '; IFS= read -r -t 1 x; test -z \"$x\"", "/tmp", 3, 0.3)!;
    for (let i = 0; i < 30 && task.status !== "waiting-for-user"; i++) await pause(20);
    assert.equal(task.status, "waiting-for-user");
    let id = 0, lease = 0;
    assert(task.attach(event => { if (event.type === "prompt") { id = event.id!; lease = event.lease!; } }));
    assert(id > 0); assert(lease <= 0.3);
    assert.equal(task.attach(() => {}), false);
    task.detach(); task.submit(id, "synthetic-only");
    await pause(350);
    task.attach(() => {}); task.submit(id, "synthetic-only");
    await task.done; assert.equal(task.status, "completed");
    assert(task.read().includes("Password:"));
  } finally { await registry.shutdown(); }
});

test("completed history expires and erases retained output", async () => {
  const registry = new TaskRegistry();
  try {
    const task = registry.start("printf synthetic-only", "/tmp", 3, 1)!;
    await task.done;
    task.endedAt = Date.now() - 600001;
    assert.equal(registry.get(task.id), undefined);
    assert.equal(task.read(), "");
  } finally { await registry.shutdown(); }
});

test("continuous output cannot starve cancellation or exceed output bounds", async () => {
  const registry = new TaskRegistry();
  try {
    const task = registry.start("while :; do printf synthetic-only; done", "/tmp", 3, 1)!;
    await pause(150);
    const before = Date.now();
    await task.stop();
    assert(Date.now() - before < 2500);
    assert.equal(task.active, false);
    assert(task.read().length <= 16384);
    assert(task.read().includes("synthetic-only"));
    assert(!JSON.stringify(task.summary()).includes("synthetic-only"));
  } finally { await registry.shutdown(); }
});

test("masked input is absent unless the command prints it; prompt waiting consumes runtime", async () => {
  const registry = new TaskRegistry();
  try {
    for (const echo of [false, true]) {
      const task = registry.start(`stty -echo; printf 'Password: '; read -r x; ${echo ? 'printf "%s" "$x"' : 'printf accepted'}`, "/tmp", 3, 1)!;
      task.attach(event => { if (event.type === "prompt") task.submit(event.id!, "synthetic-response"); });
      await task.done;
      assert.equal(task.read().includes("synthetic-response"), echo);
    }
    let notified = false;
    const task = registry.start("stty -echo; printf 'Password: '; read -r x", "/tmp", 0.5, 1, () => { notified = true; })!;
    await task.done; assert(notified); assert.equal(task.status, "timeout"); assert(task.read().includes("Password:"));
  } finally { await registry.shutdown(); }
});

test("waiting lifecycle clears on invalidation, expiry, attachment, submission and stop", async () => {
  const registry = new TaskRegistry();
  const transitions: boolean[] = [];
  try {
    const task = registry.start("stty -echo; printf 'Password: '; sleep .4; printf 'changed'; sleep .4; printf 'Password: '; sleep 10", "/tmp", 4, 0.3, (_task, waiting) => transitions.push(waiting))!;
    const wait = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await pause(20); assert(condition()); };
    await wait(() => transitions.length >= 4);
    assert.deepEqual(transitions.slice(0, 4), [true, false, true, false]);
    task.attach(() => {}); task.manual();
    await pause(100);
    task.detach(); assert.equal(transitions.at(-1), true);
    let id = 0;
    task.attach(event => { if (event.type === "prompt") id = event.id!; });
    assert.equal(transitions.at(-1), false);
    task.submit(id, "synthetic-only"); task.detach();
    assert.equal(transitions.at(-1), false);
    task.attach(() => {}); task.manual(); await pause(100); task.detach();
    assert.equal(transitions.at(-1), true);
    await task.stop(); assert.equal(transitions.at(-1), false);
  } finally { await registry.shutdown(); }
});
