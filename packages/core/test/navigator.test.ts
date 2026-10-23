/**
 * Navigator TUI tests — runs a real Pi session in a herdr pane and inspects
 * what the TUI actually renders for `/workflow`.
 *
 * With runs in the session, `/workflow` opens the agents workspace on them:
 * a sidebar with a header row per run (hidden below 80 columns) and the
 * selected agent's transcript, with `a` opening the selected node's action
 * menu. A herdr pane cannot be made wider than the host terminal, so the
 * sidebar test skips itself when the pane is narrower.
 *
 * Requires: HERDR_ENV=1, pi CLI with auth, built dist/.
 * Run: node --test dist/test/navigator.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TestHarness } from "./harness.js";

const SIDEBAR_COLUMNS = 80;
const DEPLOY = "aaaaaaaa-0000-4000-8000-000000000001";
const BUILD = "bbbbbbbb-0000-4000-8000-000000000002";
const TEST_SUITE = "cccccccc-0000-4000-8000-000000000003";

/** Seed three runs in distinct attention states and open /workflow. */
async function openWorkspace(h: TestHarness): Promise<string> {
  // Write fixtures BEFORE launching Pi
  await h.addRun({
    id: DEPLOY,
    workflowName: "deploy",
    state: "completed",
    agents: [{ name: "deployer", state: "completed", accounting: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.03 } }],
  });
  await h.addRun({
    id: BUILD,
    workflowName: "build",
    state: "running",
    phase: "review",
    agents: [
      { id: "b:1", name: "scout", state: "completed" },
      { id: "b:2", name: "reviewer", state: "running", parentId: "b:1", model: { thinking: "high" }, toolCalls: [{ id: "tc1", name: "read", state: "running" }] },
    ],
  });
  await h.addRun({
    id: TEST_SUITE,
    workflowName: "test-suite",
    state: "failed",
    agents: [{ name: "tester", state: "failed", attempts: 2, attemptDetails: [{ attempt: 2, transport: "local", session: { transport: "local", sessionId: "s", locator: { sessionFile: "/s" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, error: { code: "AGENT_FAILED", message: "assertion failed" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  });

  await h.launch();
  await h.waitFor("interrupted", 10_000);
  h.sendKey("ctrl+c");
  await new Promise((resolve) => setTimeout(resolve, 500));
  h.send("/workflow");
  await h.waitFor("a menu", 10_000);
  return h.readVisiblePane();
}

/** The live viewport once `check` holds, or the last one read. */
async function viewport(h: TestHarness, check: (screen: string) => boolean): Promise<string> {
  let screen = "";
  for (let step = 0; step < 20; step += 1) {
    screen = h.readVisiblePane();
    if (check(screen)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return screen;
}

void test("/workflow opens the agents workspace on the session's runs in attention order, without the picker", { skip: !process.env.HERDR_ENV }, async (t) => {
  const h = TestHarness.create({ prefix: "nav" });
  try {
    const screen = await openWorkspace(h);
    const width = h.paneWidth();
    if (width < SIDEBAR_COLUMNS) {
      t.skip(`pane is ${String(width)} columns; the sidebar needs at least ${String(SIDEBAR_COLUMNS)}`);
      return;
    }
    const build = screen.indexOf(`build ${BUILD.slice(0, 8)}`);
    const testSuite = screen.indexOf(`test-suite ${TEST_SUITE.slice(0, 8)}`);
    const deploy = screen.indexOf(`deploy ${DEPLOY.slice(0, 8)}`);
    assert.ok(build >= 0 && testSuite >= 0 && deploy >= 0, `Expected a header row per run in screen:\n${screen}`);
    assert.ok(build < testSuite, "interrupted should appear before failed");
    assert.ok(testSuite < deploy, "failed should appear before completed");
    assert.doesNotMatch(screen, /Model aliases|Close/, `no picker:\n${screen}`);
  } finally {
    await h.close();
  }
});

void test("a opens the selected run's actions, and on an agent its own actions without View transcript; esc closes them", { skip: !process.env.HERDR_ENV }, async () => {
  const h = TestHarness.create({ prefix: "nav-menu" });
  try {
    await openWorkspace(h);
    // /workflow opens on the first run's header, as the old dashboard opened on a run's root.
    h.sendKey("a");
    await h.waitFor("Run actions", 10_000);
    const runActions = await viewport(h, (screen) => screen.includes("Copy run ID"));
    assert.match(runActions, /Copy run ID/, `expected the run's actions:\n${runActions}`);
    // waitFor reads scrollback, which still holds the menu, so poll the live viewport.
    h.sendKey("escape");
    const runClosed = await viewport(h, (screen) => !screen.includes("Run actions"));
    assert.doesNotMatch(runClosed, /Run actions/, `escape should close the menu:\n${runClosed}`);
    // ] selects the next agent.
    h.sendKey("]");
    h.sendKey("a");
    await h.waitFor("Agent actions", 10_000);
    const withActions = await viewport(h, (screen) => screen.includes("Copy agent ID"));
    assert.match(withActions, /Copy agent ID/, `expected the agent's actions:\n${withActions}`);
    assert.doesNotMatch(withActions, /View transcript/);
    h.sendKey("escape");
    const closed = await viewport(h, (screen) => !screen.includes("Agent actions"));
    assert.doesNotMatch(closed, /Agent actions/, `escape should close the menu:\n${closed}`);
  } finally {
    await h.close();
  }
});
