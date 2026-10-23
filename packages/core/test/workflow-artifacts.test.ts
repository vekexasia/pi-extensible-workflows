import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openArtifactInEditor, openWorkflowArtifact } from "../src/workflow-artifacts.js";

function fakeTui(takes = true): { calls: string[]; tui: { stop(): boolean; start(): void; requestRender(force?: boolean): void } } {
  const calls: string[] = [];
  return { calls, tui: { stop() { calls.push("stop"); return takes; }, start() { calls.push("start"); }, requestRender(force?: boolean) { calls.push(`render ${String(force)}`); } } };
}

void test("openArtifactInEditor does not start the editor, or the terminal, when stop did not take the terminal", async () => {
  const notices: string[] = [];
  const refused = fakeTui(false);
  await openArtifactInEditor(refused.tui, "true", { extension: ".md", content: "x" }, "agent prompt", (message) => { notices.push(message); });
  assert.deepEqual(refused.calls, ["stop"]);
  assert.deepEqual(notices, []);
});

void test("openArtifactInEditor reports a missing editor, a failed exit and a failed start, and gives the terminal back", async () => {
  const artifact = { extension: ".md", content: "hello" } as const;
  const notices: string[] = [];
  const notify = (message: string): void => { notices.push(message); };

  const none = fakeTui();
  await openArtifactInEditor(none.tui, undefined, artifact, "agent prompt", notify);
  assert.deepEqual(notices, ["Cannot open agent prompt: no external editor is configured."]);
  assert.deepEqual(none.calls, [], "no editor, no terminal switch");

  notices.length = 0;
  const ok = fakeTui();
  await openArtifactInEditor(ok.tui, "true", artifact, "agent prompt", notify);
  assert.deepEqual(notices, []);
  assert.deepEqual(ok.calls, ["stop", "start", "render true"]);

  const failed = fakeTui();
  await openArtifactInEditor(failed.tui, "false", artifact, "workflow script", notify);
  assert.deepEqual(notices, ["Cannot open workflow script: external editor exited with code 1."]);
  assert.deepEqual(failed.calls, ["stop", "start", "render true"]);

  notices.length = 0;
  await openArtifactInEditor(fakeTui().tui, "/nonexistent/editor-for-test", artifact, "agent result", notify);
  assert.deepEqual(notices, ["Cannot open agent result: external editor could not be started."]);
});

void test("openWorkflowArtifact does not spawn the editor when stop did not take the terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-artifact-abort-"));
  try {
    const marker = join(dir, "started");
    const refused = fakeTui(false);
    const result = await openWorkflowArtifact(refused.tui, `touch ${marker}`, { extension: ".md", content: "x" });
    assert.equal(result, undefined);
    assert.equal(existsSync(marker), false, "the editor never ran");
    assert.deepEqual(refused.calls, ["stop"], "no start, no render");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

void test("openWorkflowArtifact starts the editor when stop returns nothing, as Pi's TUI does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-artifact-void-stop-"));
  try {
    const marker = join(dir, "started");
    const calls: string[] = [];
    const tui = { stop() { calls.push("stop"); }, start() { calls.push("start"); }, requestRender(force?: boolean) { calls.push(`render ${String(force)}`); } };
    const result = await openWorkflowArtifact(tui, `touch ${marker}`, { extension: ".md", content: "x" });
    assert.equal(result, 0);
    assert.equal(existsSync(marker), true, "the editor ran");
    assert.deepEqual(calls, ["stop", "start", "render true"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
