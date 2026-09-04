import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTrajectoryRunHtml, shareTrajectoryRun } from "../src/export.js";
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
    agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory-export" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    const html = await exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "run", home });
    assert.match(html, /window\.__PIEWF_STATIC__ = \{"type":"state"/);
    assert.ok(html.includes('"workflowName":"trajectory-export"'));
    assert.ok(html.includes('"connected":true'));
    // Transcript entries travel inline so the agent view works without a server.
    assert.ok(html.includes("hello \\u003c/script> world"));
    // No relative asset references survive; scripts and favicon are data URLs.
    assert.equal(html.includes('src="./'), false);
    assert.equal(html.includes('href="./'), false);
    assert.ok(html.includes('<script src="data:text/javascript;base64,'));
    const scripts = [...html.matchAll(/<script src="data:text\/javascript;base64,([^"]+)"><\/script>/g)].map((match) => Buffer.from(match[1] ?? "", "base64"));
    assert.equal(scripts.length, 3);
    const mermaid = scripts.find((script) => createHash("sha256").update(script).digest("hex") === "9bd6ad2cd11ed29822ccf5e2f6954b3b1e858b8e93f7148c6ae0bddc4df3aed4");
    assert.ok(mermaid);
    assert.equal(mermaid.length, 3_572_899);
    assert.equal(createHash("sha256").update(mermaid).digest("hex"), "9bd6ad2cd11ed29822ccf5e2f6954b3b1e858b8e93f7148c6ae0bddc4df3aed4");
    assert.ok(html.includes('href="data:image/png;base64,'));
    // The raw injected payload cannot terminate its script block early.
    assert.equal(html.includes("</script> world"), false);
    // $-sequences in transcripts must not trigger String.replace expansion and duplicate the document.
    assert.equal(html.split("function renderDossier").length, 2);
    assert.ok(html.includes("$' $` $& replacement traps"));
    await assert.rejects(exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "missing", home }), /was not found/);

    const stubGh = join(root, "gh");
    writeFileSync(stubGh, "#!/bin/sh\ncp \"$4\" \"$GH_STUB_CAPTURE\"\necho 'https://gist.github.com/user/abc123def456'\n", { mode: 0o755 });
    const capture = join(root, "captured.html");
    process.env.GH_STUB_CAPTURE = capture;
    try {
      const shared = await shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: stubGh });
      assert.equal(shared.gistUrl, "https://gist.github.com/user/abc123def456");
      assert.equal(shared.shareUrl, "https://vekexasia.github.io/pi-extensible-workflows/run.html#abc123def456");
      // The gist payload is the export itself under the viewer's default file name.
      assert.ok(readFileSync(capture, "utf8").includes("window.__PIEWF_STATIC__"));
    } finally {
      delete process.env.GH_STUB_CAPTURE;
    }
    const badGh = join(root, "gh-bad");
    writeFileSync(badGh, "#!/bin/sh\necho 'gh: not logged in' >&2\nexit 1\n", { mode: 0o755 });
    await assert.rejects(shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: badGh }), /not logged in/);
    await assert.rejects(shareTrajectoryRun({ cwd, sessionId: "session", runId: "run", home, ghPath: join(root, "gh-missing") }), /GitHub CLI \(gh\) is not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
