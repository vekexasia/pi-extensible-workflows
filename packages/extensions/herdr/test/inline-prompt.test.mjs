import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createHerdrExtension } from "../dist/index.js";

const SANDBOX = mkdtempSync(join(tmpdir(), "herdr-inline-prompt-tests-"));
const SOCKET_PATH = join(SANDBOX, "h.sock");
const piRuntime = { executable: process.execPath, entrypoint: "/originating/pi-coding-agent/dist/cli.js" };
process.on("exit", () => { rmSync(SANDBOX, { recursive: true, force: true }); });

async function captureLaunch({ prompt = "prompt", prepared = {}, contextFiles } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-inline-prompt-"));
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensionSettings: { herdr: { enableFullyInspectableMode: true } } }));
  writeFileSync(sessionFile, "");
  let command;
  let runCall;
  const runner = async (args) => {
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } });
    if (args[0] === "pane" && args[1] === "run") {
      runCall = [...args];
      const script = /sh '([^']+)'$/.exec(args[3]);
      command = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { agent_status: "idle" } } });
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET_PATH, HERDR_PANE_ID: "parent" }, runner });
  const localSession = {
    reference: { transport: "local", sessionId: "session", locator: { sessionFile } },
    ...(contextFiles === undefined ? {} : { getHerdrContextFiles: () => contextFiles }),
    suspendForHandoff: async () => {},
    resumeFromHandoff: async () => {},
    abort: async () => {},
    getLastAssistant: () => undefined,
    prompt: async () => ({}),
    steer: async () => {},
    dispose: async () => {},
    getState: () => ({ model: { provider: "fake", model: "model" }, tools: [] }),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
  };
  const agent = { transport: { id: "local", async createSession() { return localSession; } } };
  const identity = { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 };
  const signal = new AbortController().signal;
  extension.agentSetupHooks.fullyInspectable.setup(agent, { identity, run: { runId: "run", workflow: { name: "flow" } }, signal });
  const preparedSession = { cwd: root, agentDir, model: { provider: "fake", model: "model" }, tools: [], initialPrompt: prompt, sessionLabel: "flow:review", piRuntime, ...prepared };
  const session = await agent.transport.createSession(preparedSession, { identity, attempt: 1, signal });
  return { command, runCall, session, root };
}

test("inlines safe prompt arguments and keeps launcher artifacts bounded", async () => {
  const contextPrompt = "<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"/repo/AGENTS.md\">\ncontext instructions\n</project_instructions>\n</project_context>\n";
  const launch = await captureLaunch({
    prompt: "ordinary prompt",
    prepared: { systemPrompt: "system instructions", systemPromptAppend: "append instructions", contextFiles: ["project"], settings: { acme: { enabled: true } } },
    contextFiles: [{ path: "/repo/AGENTS.md", content: "context instructions" }],
  });
  try {
    assert.ok(launch.command);
    assert.ok(launch.runCall);
    assert.match(launch.command, /--session '[^']+\/session\.jsonl'/);
    assert.match(launch.command, /--system-prompt 'system instructions'/);
    assert.match(launch.command, /--append-system-prompt 'append instructions'/);
    assert.ok(launch.command.includes(`--append-system-prompt '${contextPrompt}'`));
    assert.match(launch.command, / 'ordinary prompt'\n?$/);
    assert.doesNotMatch(launch.command, /@'ordinary prompt'/);
    assert.doesNotMatch(launch.command, /pi-herdr-prompt-/);
    assert.doesNotMatch(launch.command, /pi-herdr-[^'\s]+\.txt/);
    assert.ok(launch.runCall[3].length < 4096);
    const settingsPath = /PI_EXTENSIBLE_WORKFLOWS_SETTINGS_FILE='([^']+\.json)'/.exec(launch.command)?.[1];
    assert.ok(settingsPath);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { acme: { enabled: true } });
  } finally {
    await launch.session.dispose();
    await rm(launch.root, { recursive: true, force: true });
  }
});

test("falls back to private markdown prompt files for unsafe inline values", async () => {
  for (const prompt of ["@literal", "- option", "x".repeat(65_537), "nul\0value", process.cwd()]) {
    const launch = await captureLaunch({ prompt });
    let promptPath;
    try {
      assert.ok(launch.command);
      promptPath = /@'([^']+\.md)'/.exec(launch.command)?.[1];
      assert.ok(promptPath);
      assert.equal(readFileSync(promptPath, "utf8"), prompt);
      assert.equal(statSync(promptPath).mode & 0o777, 0o600);
      assert.equal(statSync(join(promptPath, "..")).mode & 0o777, 0o700);
      assert.doesNotMatch(launch.command, /pi-herdr-[^'\s]+\.txt/);
    } finally {
      await launch.session.dispose();
      assert.throws(() => statSync(promptPath), /ENOENT/);
      await rm(launch.root, { recursive: true, force: true });
    }
  }
});
