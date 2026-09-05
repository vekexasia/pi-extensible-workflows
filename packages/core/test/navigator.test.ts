/**
 * Navigator TUI tests — runs a real Pi session in a herdr pane and inspects
 * what the TUI actually renders for `/workflow`.
 *
 * The dashboard has two layouts: a two-column tree-and-details view at 80
 * columns or wider, and a single-column drill-down below that. A herdr pane
 * cannot be made wider than the host terminal, so each layout test skips
 * itself when the pane it gets cannot produce that layout.
 *
 * Requires: HERDR_ENV=1, pi CLI with auth, built dist/.
 * Run: node --test dist/test/navigator.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TestHarness } from "./harness.js";

const WIDE_LAYOUT_COLUMNS = 80;

/** Seed three runs in distinct attention states and open the dashboard. */
async function openNavigator(h: TestHarness): Promise<string> {
  // Write fixtures BEFORE launching Pi
  await h.addRun({
    workflowName: "deploy",
    state: "completed",
    agents: [{ name: "deployer", state: "completed", accounting: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.03 } }],
  });
  await h.addRun({
    workflowName: "build",
    state: "running",
    phase: "review",
    agents: [
      { id: "b:1", name: "scout", state: "completed" },
      { id: "b:2", name: "reviewer", state: "running", parentId: "b:1", model: { thinking: "high" }, toolCalls: [{ id: "tc1", name: "read", state: "running" }] },
    ],
  });
  await h.addRun({
    workflowName: "test-suite",
    state: "failed",
    agents: [{ name: "tester", state: "failed", attempts: 2, attemptDetails: [{ attempt: 2, transport: "local", session: { transport: "local", sessionId: "s", locator: { sessionFile: "/s" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, error: { code: "AGENT_FAILED", message: "assertion failed" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  });

  await h.launch();
  await h.waitFor("interrupted", 10_000);
  h.sendKey("ctrl+c");
  await new Promise((resolve) => setTimeout(resolve, 500));
  h.send("/workflow");
  await h.waitFor("build  interrupted", 10_000);
  return h.readVisiblePane();
}

/** Step the tree until an agent leaf is selected, returning its name. */
async function selectAgentRow(h: TestHarness): Promise<string> {
  for (let step = 0; step < 12; step += 1) {
    const match = /→.*?(scout|reviewer)/.exec(h.readVisiblePane());
    if (match) return match[1] ?? "";
    h.sendKey("down");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return "";
}

void test("navigator shows attention-ordered runs in the real TUI", { skip: !process.env.HERDR_ENV }, async () => {
  const h = TestHarness.create({ prefix: "nav" });
  try {
    const screen = await openNavigator(h);
    const normalized = screen.replace(/\s+/g, " ");

    const buildLine = normalized.indexOf("build interrupted");
    const testLine = normalized.indexOf("test-suite failed");
    const deployLine = normalized.indexOf("deploy completed");

    assert.ok(buildLine >= 0, `Expected 'build interrupted' in screen:\n${screen}`);
    assert.ok(testLine >= 0, `Expected 'test-suite failed' in screen:\n${screen}`);
    assert.ok(deployLine >= 0, `Expected 'deploy completed' in screen:\n${screen}`);
    assert.ok(buildLine < testLine, `interrupted should appear before failed`);
    assert.ok(testLine < deployLine, `failed should appear before completed`);
    assert.ok(screen.includes("Close"), `Expected 'Close' option`);
  } finally {
    await h.close();
  }
});

void test("narrow navigator drills from tree to details to agent actions", { skip: !process.env.HERDR_ENV }, async (t) => {
  const h = TestHarness.create({ prefix: "nav-narrow" });
  try {
    await openNavigator(h);
    const width = h.paneWidth();
    if (width >= WIDE_LAYOUT_COLUMNS) {
      t.skip(`pane is ${String(width)} columns; narrow layout needs fewer than ${String(WIDE_LAYOUT_COLUMNS)}`);
      return;
    }

    h.sendKey("enter");
    await h.waitFor("Tree", 10_000);
    const tree = h.readVisiblePane();
    assert.match(tree, /Tree/);
    assert.match(tree, /review/);
    assert.doesNotMatch(tree, /Agents\.\.\./);
    // Narrow mode is single-column: no details separator beside the tree.
    assert.doesNotMatch(tree, / \| /);
    // Enter on the workflow root opens run actions directly (#188).
    h.sendKey("enter");
    await h.waitFor("Run actions", 10_000);
    assert.match(h.readVisiblePane(), /Open script in editor/);
    h.sendKey("escape");
    const selectedAgent = await selectAgentRow(h);
    assert.ok(selectedAgent, "expected an agent row to be selected");

    // First Enter opens details for the selected agent.
    h.sendKey("enter");
    await h.waitFor("State:", 10_000);

    // Second Enter on an agent opens its actions.
    h.sendKey("enter");
    await h.waitFor("Agent actions", 10_000);
    const withActions = h.readVisiblePane();
    assert.match(withActions, /→ Copy agent ID/, `expected a selected action row:\n${withActions}`);

    // Escape returns to the tree rather than leaving the dashboard. waitFor reads
    // scrollback, which still holds the earlier tree, so poll the live viewport.
    h.sendKey("escape");
    let backOnTree = "";
    for (let step = 0; step < 20; step += 1) {
      backOnTree = h.readVisiblePane();
      if (!backOnTree.includes("Agent actions")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.doesNotMatch(backOnTree, /Agent actions/, `escape should leave the action list:\n${backOnTree}`);
  } finally {
    await h.close();
  }
});

void test("wide navigator shows the tree beside details and opens agent actions inline", { skip: !process.env.HERDR_ENV }, async (t) => {
  const h = TestHarness.create({ prefix: "nav-wide" });
  try {
    await openNavigator(h);
    const width = h.paneWidth();
    if (width < WIDE_LAYOUT_COLUMNS) {
      t.skip(`pane is ${String(width)} columns; wide layout needs at least ${String(WIDE_LAYOUT_COLUMNS)}`);
      return;
    }

    h.sendKey("enter");
    await h.waitFor("Tree", 10_000);
    const detail = h.readVisiblePane();
    assert.match(detail, /Tree/);
    assert.match(detail, /review/);
    assert.doesNotMatch(detail, /Agents\.\.\./);
    // Wide mode renders tree and details side by side.
    assert.match(detail, / \| /, `expected a two-column layout at ${String(width)} columns:\n${detail}`);

    const selectedAgent = await selectAgentRow(h);
    assert.ok(selectedAgent, "expected an agent row to be selected");

    // Wide mode skips the details step: Enter on an agent opens its actions.
    h.sendKey("enter");
    await h.waitFor("Agent actions", 10_000);
    const withActions = h.readVisiblePane();
    assert.match(withActions, /→ Copy agent ID/, `expected a selected action row:\n${withActions}`);
    const actionRow = withActions.split("\n").find((line) => line.includes("Copy agent ID"));
    assert.ok(actionRow, `expected an agent action row:\n${withActions}`);
    assert.match(actionRow, /\|/, `agent actions must stay in the details column: ${actionRow}`);
  } finally {
    await h.close();
  }
});
