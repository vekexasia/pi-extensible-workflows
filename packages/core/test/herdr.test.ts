import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrAgentReporter, herdrPaneCommand, herdrPaneId, openHerdrPane, openHerdrWorkspacePane, waitForHerdrPane } from "../src/herdr.js";

void test("gates Herdr actions on the managed pane environment", () => {
  assert.equal(herdrPaneId({ HERDR_ENV: "0", HERDR_PANE_ID: "pane" }), undefined);
  assert.equal(herdrPaneId({ HERDR_ENV: "1" }), undefined);
  assert.equal(herdrPaneId({ HERDR_ENV: "1", HERDR_PANE_ID: " opaque-pane " }), "opaque-pane");
});

void test("targets the declared Herdr pane, chooses geometry, escapes live commands, and forwards agent environments", async () => {
  const previousEnvironment = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "declared-pane";
  process.env.PI_CODING_AGENT_DIR = "/tmp/agent dir";
  process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/session's dir";
  const liveCommand = "pi --session '/tmp/original'\\''s.jsonl'";
  try {
    const command = herdrPaneCommand({ action: "live", cwd: "/tmp/work dir", command: liveCommand });
    assert.match(command, /cd '\/tmp\/work dir'/);
    assert.match(command, /PI_CODING_AGENT_DIR='\/tmp\/agent dir'/);
    assert.match(command, /PI_CODING_AGENT_SESSION_DIR='\/tmp\/session'\\''s dir'/);
    assert.match(command, /pi --session '\/tmp\/original'\\''s\.jsonl'/);

    const calls: string[][] = [];
    const runner = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "declared-pane", rect: { width: 20, height: 80 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } });
      return "";
    };
    assert.equal(await openHerdrPane({ action: "live", cwd: "/tmp/work", command: liveCommand }, runner), "opaque:new-pane");
    assert.deepEqual(calls.slice(0, 2), [
      ["pane", "layout", "--pane", "declared-pane"],
      ["pane", "split", "declared-pane", "--direction", "down", "--no-focus"],
    ]);
    const runCall = calls[2];
    assert.ok(runCall);
    assert.equal(runCall[0], "pane");
    assert.equal(runCall[1], "run");
    assert.equal(runCall[2], "opaque:new-pane");
    assert.equal(runCall[3], `cd '/tmp/work' && PI_CODING_AGENT_DIR='/tmp/agent dir' PI_CODING_AGENT_SESSION_DIR='/tmp/session'\\''s dir' ${liveCommand}`);

    const equalCalls: string[][] = [];
    const equalRunner = async (args: readonly string[]): Promise<string> => {
      equalCalls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "declared-pane", rect: { width: 80, height: 80 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "equal:new-pane" } } });
      return "";
    };
    await openHerdrPane({ action: "live", cwd: "/tmp/work", command: liveCommand }, equalRunner);
    assert.deepEqual(equalCalls[1], ["pane", "split", "declared-pane", "--direction", "down", "--no-focus"]);

    const failingCalls: string[][] = [];
    const failingRunner = async (args: readonly string[]): Promise<string> => {
      failingCalls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "declared-pane", rect: { width: 100, height: 20 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "created-only-by-this-action" } } });
      if (args[1] === "run") throw new Error("startup failed");
      return "";
    };
    await assert.rejects(openHerdrPane({ action: "live", cwd: "/tmp/work", command: liveCommand }, failingRunner), /startup failed/);
    assert.deepEqual(failingCalls[1], ["pane", "split", "declared-pane", "--direction", "right", "--no-focus"]);
    assert.deepEqual(failingCalls.at(-1), ["pane", "close", "created-only-by-this-action"]);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});

void test("creates a dedicated labeled workspace and reports ordered agent lifecycle", async () => {
  const previousEnvironment = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR };
  Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  Reflect.deleteProperty(process.env, "PI_CODING_AGENT_SESSION_DIR");
  try {
  const calls: string[][] = [];
  const runner = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "workspace") return JSON.stringify({ result: { workspace: { workspace_id: "workspace-1" }, tab: { tab_id: "tab-1" }, root_pane: { pane_id: "pane-1" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } } });
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
    return "";
  };
  const pane = await openHerdrWorkspacePane({ cwd: "/repo", workspaceLabel: "flow > review #1", tabLabel: "flow > review #1", command: "pi --session /tmp/session.jsonl" }, runner);
  assert.deepEqual(pane, { workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-2" });
  const reporter = createHerdrAgentReporter(pane.paneId, "review", runner);
  await reporter.reportSession({ sessionPath: "/tmp/session.jsonl" }, "workflow-agent");
  await reporter.reportState("working", undefined, { sessionPath: "/tmp/session.jsonl" });
  await reporter.release();
  await reporter.release();
  assert.deepEqual(calls.slice(0, 4), [
    ["workspace", "create", "--cwd", "/repo", "--label", "flow > review #1", "--no-focus"],
    ["tab", "rename", "tab-1", "flow > review #1"],
    ["tab", "create", "--workspace", "workspace-1", "--cwd", "/repo", "--label", "flow > review #1", "--no-focus"],
    ["pane", "run", "pane-2", "cd '/repo' && pi --session /tmp/session.jsonl"],
  ]);
  const reportCalls = calls.filter(([command, subcommand]) => command === "pane" && ["report-agent-session", "report-agent", "release-agent"].includes(subcommand ?? ""));
  assert.equal(reportCalls.length, 3);
  const sequences = reportCalls.map((call) => Number(call[call.indexOf("--seq") + 1]));
  const [first, second, third] = sequences;
  assert.ok(first !== undefined && second !== undefined && third !== undefined && first < second && second < third);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});
void test("waits for Pi startup before reporting an exit", async () => {
  let processReports = 0;
  let statusReports = 0;
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "pane") {
      processReports += 1;
      if (processReports === 1) return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
      if (processReports === 2) return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: ["node", "/home/node/bin/pi"], cmdline: "node /home/node/bin/pi" }] } } });
      return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
    }
    statusReports += 1;
    return JSON.stringify({ result: { agent: { agent_status: statusReports === 1 ? "working" : "idle" } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { intervalMs: 0, exitGraceMs: 0 }), "exited");
  assert.equal(processReports, 3);
});
void test("tolerates a transient process gap while Pi starts", async () => {
  let processReports = 0;
  let statusReports = 0;
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "pane") {
      processReports += 1;
      const running = processReports !== 2;
      return JSON.stringify({ result: { process_info: { foreground_processes: running ? [{ name: "pi", argv: ["pi"] }] : [] } } });
    }
    statusReports += 1;
    return JSON.stringify({ result: { agent: { agent_status: statusReports === 1 ? "working" : "idle" } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { intervalMs: 0 }), "idle");
  assert.equal(processReports, 3);
});
void test("accepts Herdr-normalized Pi processes after exact startup", async () => {
  let processReports = 0;
  const originatingEntrypoint = "/workspace/pi/packages/coding-agent/dist/cli.js";
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[1] !== "process-info") return "";
    processReports += 1;
    if (processReports === 1) return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, originatingEntrypoint], cmdline: `${process.execPath} ${originatingEntrypoint}` }] } } });
    if (processReports === 2) return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv0: "pi" }] } } });
    return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { originatingEntrypoint, intervalMs: 0, exitGraceMs: 0 }), "exited");
  assert.equal(processReports, 3);
});

void test("reports a pane startup failure instead of waiting forever", async () => {
  await assert.rejects(waitForHerdrPane("pane", async () => JSON.stringify({ result: { process_info: { foreground_processes: [] } } }), { intervalMs: 0, startupTimeoutMs: 0 }), /did not start Pi/);
});

void test("does not treat startup idle as a finished turn", async () => {
  const controller = new AbortController();
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "pane") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", argv: ["pi"] }] } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    controller.abort();
    return JSON.stringify({ result: { agent: { agent_status: "idle" } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { intervalMs: 0, signal: controller.signal }), "aborted");
});

void test("detects a running Herdr agent returning idle after a turn", async () => {
  let reports = 0;
  const states: string[] = [];
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "pane") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", argv: ["pi"] }] } } });
    reports += 1;
    return JSON.stringify({ result: { agent: { agent_status: reports === 1 ? "working" : "idle" } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { intervalMs: 0, onStatus: (state) => { states.push(state); } }), "idle");
  assert.deepEqual(states, ["working", "idle"]);
});

void test("does not let status notifications suppress idle handback", async () => {
  const controller = new AbortController();
  let reports = 0;
  const runner = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "pane") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", argv: ["pi"] }] } } });
    reports += 1;
    if (reports === 2) controller.abort();
    return JSON.stringify({ result: { agent: { agent_status: reports === 1 ? "working" : "idle" } } });
  };
  assert.equal(await waitForHerdrPane("pane", runner, { intervalMs: 0, signal: controller.signal, onStatus: () => { throw new Error("notification failed"); } }), "idle");
});
