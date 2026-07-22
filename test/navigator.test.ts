/**
 * Navigator TUI tests — runs a real Pi session in a herdr pane and inspects
 * what the TUI actually renders for `/workflow`.
 *
 * Requires: HERDR_ENV=1, pi CLI with auth, built dist/.
 * Run: node --test dist/test/navigator.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TestHarness } from "./harness.js";

void test("navigator shows attention-ordered runs in the real TUI", { skip: !process.env.HERDR_ENV }, async () => {
  const h = TestHarness.create({ prefix: "nav" });
  try {
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
      agents: [{ name: "tester", state: "failed", attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "s", sessionFile: "/s", error: { code: "AGENT_FAILED", message: "assertion failed" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
    });

    await h.launch();
    await h.waitFor("interrupted", 10_000);
    h.sendKey("ctrl+c");
    await new Promise((resolve) => setTimeout(resolve, 500));
    h.send("/workflow");
    await h.waitFor("Close", 10_000);

    const screen = h.readPane(40);
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
