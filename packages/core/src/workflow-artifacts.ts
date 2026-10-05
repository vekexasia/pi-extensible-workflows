import { spawnExecutable } from "./process-launcher.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "./types.js";

export interface WorkflowArtifact { extension: ".js" | ".json" | ".md"; content: string }
export type WorkflowTui = { stop(): void; start(): void; requestRender(force?: boolean): void };

export function workflowScriptArtifact(script: string): WorkflowArtifact { return { extension: ".js", content: script }; }
export function workflowPromptArtifact(prompt: string): WorkflowArtifact { return { extension: ".md", content: prompt }; }
export function workflowResultArtifact(value: JsonValue): WorkflowArtifact { return typeof value === "string" ? { extension: ".md", content: value } : { extension: ".json", content: `${JSON.stringify(value, null, 2)}\n` }; }

function parseEditorCommand(command: string): string[] {
  const result: string[] = [];
  let value = "";
  let quote: "'" | "\"" | undefined;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (next === quote || next === "\\" || (process.platform !== "win32" && /\s/.test(next ?? ""))) {
        value += next ?? "";
        index += 1;
        started = true;
        continue;
      }
    }
    if (quote === undefined && (character === "'" || character === "\"")) { quote = character; started = true; continue; }
    if (character === quote) { quote = undefined; continue; }
    if (quote === undefined && /\s/.test(character ?? "")) {
      if (started) result.push(value);
      value = "";
      started = false;
      continue;
    }
    value += character ?? "";
    started = true;
  }
  if (quote !== undefined) throw new Error("EDITOR contains an unmatched quote");
  if (started) result.push(value);
  return result;
}

async function spawnWorkflowEditor(command: string, path: string): Promise<number | null> {
  let parsed: string[];
  try { parsed = parseEditorCommand(command); }
  catch { return null; }
  const [editor, ...editorArgs] = parsed;
  if (!editor) return null;
  return new Promise((resolve) => {
    try {
      // EDITOR/VISUAL is trusted user configuration. Common Windows editors (for example VS Code's `code`) are plain
      // batch launchers, so allow them explicitly; the launcher quotes every argument and never sets `shell: true`.
      const child = spawnExecutable(editor, [...editorArgs, path], { stdio: "inherit", windowsHide: true }, { allowBatchFile: true });
      child.once("error", () => { resolve(null); });
      child.once("close", (code) => { resolve(code); });
    } catch { resolve(null); }
  });
}

export async function openWorkflowArtifact(tui: WorkflowTui, command: string, artifact: WorkflowArtifact): Promise<number | null> {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-editor-"));
  const path = join(directory, `artifact${artifact.extension}`);
  try {
    await writeFile(path, artifact.content, { encoding: "utf8", mode: 0o600 });
    tui.stop();
    try { return await spawnWorkflowEditor(command, path); }
    finally { tui.start(); tui.requestRender(true); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
