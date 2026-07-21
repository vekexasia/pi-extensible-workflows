import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type HerdrPaneAction = "inspect" | "transcript" | "fork";
export interface HerdrPaneRequest { action: HerdrPaneAction; cwd: string; sessionId?: string; original?: string; readOnly?: boolean }
export type HerdrCommandRunner = (args: readonly string[]) => Promise<string>;

const runHerdr: HerdrCommandRunner = (args) => new Promise<string>((resolve, reject) => {
  execFile("herdr", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(new Error(error.message)); return; }
    resolve(stdout);
  });
});

export function herdrPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId || undefined;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function json(value: string): unknown { return JSON.parse(value) as unknown; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function paneLayout(value: unknown, targetPane: string): { width: number; height: number } {
  const root = record(value);
  const result = record(root?.result);
  const layout = record(result?.layout);
  const rawPanes = layout?.panes;
  if (!Array.isArray(rawPanes)) throw new Error("Herdr returned an invalid pane layout.");
  const panes: unknown[] = rawPanes;
  const pane = panes.find((candidate: unknown) => record(candidate)?.pane_id === targetPane);
  const rect = record(record(pane)?.rect);
  const width = rect?.width;
  const height = rect?.height;
  if (width === undefined || height === undefined || typeof width !== "number" || typeof height !== "number") throw new Error("Herdr returned an invalid target pane geometry.");
  return { width, height };
}
function splitPaneId(value: unknown): string {
  const pane = record(record(record(value)?.result)?.pane);
  const paneId = pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) throw new Error("Herdr returned an invalid created pane ID.");
  return paneId;
}

function commandFor(request: HerdrPaneRequest): string {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.resolve("pi-extensible-workflows")));
  const environment = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].flatMap((name) => process.env[name] === undefined ? [] : [`${name}=${shellQuote(process.env[name] ?? "")}`]);
  const command = request.action === "inspect"
    ? [shellQuote(process.execPath), shellQuote(cliPath), "inspect", shellQuote(request.sessionId ?? "")]
    : request.action === "transcript"
      ? [shellQuote(process.execPath), shellQuote(cliPath), "transcript", shellQuote(request.original ?? "")]
      : ["pi", "--fork", shellQuote(request.original ?? ""), ...(request.readOnly ? ["--tools", shellQuote("read,grep,find,ls")] : [])];
  return `cd ${shellQuote(request.cwd)} && ${environment.length ? `${environment.join(" ")} ` : ""}${command.join(" ")}`;
}

export function herdrPaneCommand(request: HerdrPaneRequest): string { return commandFor(request); }

export async function openHerdrPane(request: HerdrPaneRequest, runner: HerdrCommandRunner = runHerdr): Promise<string> {
  const targetPane = herdrPaneId();
  if (!targetPane) throw new Error("Pane actions require a Herdr-managed session with HERDR_PANE_ID.");
  if (!request.cwd) throw new Error("Pane actions require a working directory.");
  if ((request.action === "inspect" && !request.sessionId) || (request.action !== "inspect" && !request.original)) throw new Error("Pane action is missing its session source.");
  const layout = paneLayout(json(await runner(["pane", "layout", "--pane", targetPane])), targetPane);
  const direction = layout.width >= layout.height ? "right" : "down";
  const paneId = splitPaneId(json(await runner(["pane", "split", targetPane, "--direction", direction, "--no-focus"])));
  try {
    await runner(["pane", "run", paneId, commandFor(request)]);
    return paneId;
  } catch (error) {
    await runner(["pane", "close", paneId]).catch(() => undefined);
    throw error;
  }
}