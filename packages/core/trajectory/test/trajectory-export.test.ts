import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTrajectoryRunHtml, shareTrajectoryRun } from "../index.js";
import { RunStore } from "../../src/persistence.js";
import { createLaunchSnapshot } from "../../src/utils.js";
import type { PersistedRun } from "../../src/persistence.js";

void test("exportTrajectoryRunHtml renders a self-contained static run report", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-export-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const transcriptText = "hello </script> world and $' $` $& replacement traps";
  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: transcriptText }] } })}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "fixture-model" };
  const run = {
    id: "run", workflowName: "trajectory-export", cwd, sessionId: "session", state: "completed", agentSessions: [],
    agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", resultPath: "agent/call:1", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: { nested: ["<img>", false] }, metadata: { name: "trajectory-export" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    await store.complete("agent/call:1", { answer: false });
    const html = await exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "run", home });
    assert.match(html, /window\.__PIEWF_STATIC__ = \{"type":"state"/);
    assert.ok(html.includes('"workflowName":"trajectory-export"'));
    assert.ok(html.includes('"connected":true'));
    assert.ok(html.includes('"args":{"nested":["\\u003cimg>",false]}'));
    assert.ok(html.includes('"output":{"status":"available","value":{"answer":false}'));
    // Transcript entries travel inline so the agent view works without a server.
    assert.ok(html.includes("hello \\u003c/script> world"));
    // No relative asset references survive; scripts and favicon are data URLs.
    assert.equal(html.includes('src="./'), false);
    assert.equal(html.includes('href="./'), false);
    assert.ok(html.includes('<script src="data:text/javascript;base64,'));
    assert.ok(html.includes('href="data:image/png;base64,'));
    assert.ok(html.includes("Semantic Map is available for live Trajectory sessions only; this is a static export."));
    assert.equal(html.includes('<iframe src="./semantic-map.html'), false);
    // The raw injected payload cannot terminate its script block early.
    assert.equal(html.includes("</script> world"), false);
    // $-sequences in transcripts must not trigger String.replace expansion and duplicate the document.
    assert.equal(html.split("function renderDossier").length, 2);
    assert.ok(html.includes("$' $` $& replacement traps"));
    await assert.rejects(exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "missing", home }), /was not found/);

    const stubGh = join(root, "gh stub.mjs");
    writeFileSync(stubGh, "import { copyFileSync, writeFileSync } from 'node:fs'; copyFileSync(process.argv.at(-1), process.env.GH_STUB_CAPTURE); writeFileSync(process.env.GH_STUB_ARGS, JSON.stringify(process.argv.slice(2))); process.stdout.write('https://gist.github.com/user/abc123def456\\n');\n");
    const capture = join(root, "captured.html");
    const argsCapture = join(root, "captured-args.json");
    process.env.GH_STUB_CAPTURE = capture;
    process.env.GH_STUB_ARGS = argsCapture;
    try {
      const shared = await shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: stubGh });
      assert.equal(shared.gistUrl, "https://gist.github.com/user/abc123def456");
      assert.equal(shared.shareUrl, "https://vekexasia.github.io/pi-extensible-workflows/run.html#abc123def456");
      // The gist payload is the export itself under the viewer's default file name.
      assert.ok(readFileSync(capture, "utf8").includes("window.__PIEWF_STATIC__"));
      // The stub ran as a real child process with literal argv; the temporary upload copy is removed afterwards.
      const ghArgs = JSON.parse(readFileSync(argsCapture, "utf8")) as string[];
      assert.deepEqual(ghArgs.slice(0, 3), ["gist", "create", "--public=false"]);
      assert.match(ghArgs[3] ?? "", /piewf-share-.*trajectory\.html$/);
      assert.equal(existsSync(ghArgs[3] ?? ""), false);
    } finally {
      delete process.env.GH_STUB_CAPTURE;
      delete process.env.GH_STUB_ARGS;
    }
    const badGh = join(root, "gh bad.mjs");
    writeFileSync(badGh, "process.stderr.write('gh: not logged in\\n'); process.exitCode = 1;\n");
    await assert.rejects(shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: badGh }), /not logged in/);
    await assert.rejects(shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: join(root, "gh-missing") }), /GitHub CLI \(gh\) is not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
