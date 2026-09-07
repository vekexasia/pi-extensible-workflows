import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isTurnActivityStart, isTurnBoundaryEnd } from "../src/pi-runtime-adapter.js";
import { createLiveSessionHandoff } from "../src/session-handoff.js";

void test("live session handoff waits for turn_end and releases ownership once", async () => {
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  let launched = false;
  let finishPane!: () => void;
  const paneClosed = new Promise<void>((resolve) => { finishPane = resolve; });
  const opening = handoff.request(async () => {
    launched = true;
    await paneClosed;
  });

  await Promise.resolve();
  assert.equal(launched, false);
  assert.equal(handoff.state, "handoff-pending");
  handoff.observe({ type: "turn_end" });
  await Promise.resolve();
  assert.equal(launched, true);
  assert.equal(handoff.state, "herdr-running");
  const resumed = handoff.waitForResume();
  finishPane();
  await opening;
  await resumed;
  assert.equal(handoff.state, "completed");
  handoff.release("pane.closed");
  assert.equal(handoff.state, "completed");
});

void test("live session handoff pauses the local owner until takeover", async () => {
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const opening = handoff.request(async () => {
    handoff.takeover();
  });
  const paused = handoff.waitForTakeover();
  let resolved = false;
  void paused.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  handoff.observe({ type: "turn_end" });
  await opening;
  await paused;
  assert.equal(resolved, true);
});

void test("live session handoff observes each event alias and settles waiters after launch failure", async () => {
  const aliases = [
    ["turn_start", "turn_end"],
    ["turn_started", "turnEnded"],
    ["turnStarted", "agent_end"],
    ["agent_start", "agent_settled"],
  ] as const;
  for (const [startType, endType] of aliases) {
    const handoff = createLiveSessionHandoff();
    handoff.observe({ type: startType });
    let launched = false;
    const opening = handoff.request(async () => { launched = true; throw new Error("pane failed"); });
    const takeover = handoff.waitForTakeover();
    const resumed = handoff.waitForResume();
    await Promise.resolve();
    assert.equal(launched, false);
    assert.equal(handoff.state, "handoff-pending");
    handoff.observe({ type: endType });
    await assert.rejects(opening, /pane failed/);
    await takeover;
    await resumed;
    assert.equal(launched, true);
    assert.equal(handoff.state, "completed");
  }
});

void test("duplicate handoff requests share one launch and settle together", async () => {
  const handoff = createLiveSessionHandoff();
  let launches = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const launch = async () => { launches += 1; await gate; };
  const first = handoff.request(launch);
  const second = handoff.request(async () => { launches += 1; });
  release();
  await Promise.all([first, second]);
  assert.equal(launches, 1);
  assert.equal(handoff.state, "completed");
});

void test("handoff turn boundaries come from the shared Pi event vocabulary", () => {
  for (const type of ["turn_start", "turn_started", "turnStarted", "agent_start"]) assert.equal(isTurnActivityStart(type), true, type);
  assert.equal(isTurnActivityStart("turn_end"), false);
  for (const type of ["turn_end", "turnEnded", "agent_end", "agent_settled"]) assert.equal(isTurnBoundaryEnd(type), true, type);
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/session-handoff.ts"), "utf8");
  assert.doesNotMatch(source, /"turn_start"/, "session-handoff must not restate the turn-start event list");
  assert.doesNotMatch(source, /"turn_end"/, "session-handoff must not restate the turn-end event list");
  assert.match(source, /import \{[^}]*\bisTurnActivityStart\b[^}]*\} from "\.\/pi-runtime-adapter\.js";/);
});
