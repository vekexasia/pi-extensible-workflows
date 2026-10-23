import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "./types.js";
import { errorText } from "./utils.js";

export interface WorkflowArtifact { extension: ".js" | ".json" | ".md" | ".diff"; content: string }
export type WorkflowTui = { /** false: the terminal was not taken and the editor must not start; any other result (Pi's TUI returns nothing) starts it. */ stop(): unknown; start(): void; requestRender(force?: boolean): void };

export function workflowScriptArtifact(script: string): WorkflowArtifact { return { extension: ".js", content: script }; }
export function workflowPromptArtifact(prompt: string): WorkflowArtifact { return { extension: ".md", content: prompt }; }
export function workflowResultArtifact(value: JsonValue): WorkflowArtifact { return typeof value === "string" ? { extension: ".md", content: value } : { extension: ".json", content: `${JSON.stringify(value, null, 2)}\n` }; }

async function spawnWorkflowEditor(command: string, path: string): Promise<number | null> {
  const [editor, ...editorArgs] = command.split(" ");
  if (!editor) return null;
  return new Promise((resolve) => {
    try {
      const child = spawn(editor, [...editorArgs, path], { stdio: "inherit", shell: process.platform === "win32" });
      child.once("error", () => { resolve(null); });
      child.once("close", (code) => { resolve(code); });
    } catch { resolve(null); }
  });
}

/** The editor's exit code, null when it could not start, undefined when the terminal was not taken (the edit is cancelled). */
export async function openWorkflowArtifact(tui: WorkflowTui, command: string, artifact: WorkflowArtifact): Promise<number | null | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-editor-"));
  const path = join(directory, `artifact${artifact.extension}`);
  try {
    await writeFile(path, artifact.content, { encoding: "utf8", mode: 0o600 });
    if (tui.stop() === false) return undefined;
    try { return await spawnWorkflowEditor(command, path); }
    finally { tui.start(); tui.requestRender(true); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Opens the artifact in the external editor and reports, as the dashboards do, a missing editor, a failed start or a failed exit. */
export async function openArtifactInEditor(tui: WorkflowTui, command: string | undefined, artifact: WorkflowArtifact, label: string, notify: (message: string, level: "warning") => void): Promise<void> {
  if (!command) { notify(`Cannot open ${label}: no external editor is configured.`, "warning"); return; }
  try {
    const exitCode = await openWorkflowArtifact(tui, command, artifact);
    if (exitCode !== undefined && exitCode !== 0) notify(`Cannot open ${label}: external editor ${exitCode === null ? "could not be started" : `exited with code ${String(exitCode)}`}.`, "warning");
  } catch (error) { notify(`Cannot open ${label}: ${errorText(error)}`, "warning"); }
}
