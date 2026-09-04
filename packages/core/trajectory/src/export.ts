import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrajectoryRuns } from "../../src/trajectory.js";

export type TrajectoryExportOptions = { cwd: string; sessionId: string; runId: string; home?: string };
export type TrajectoryShareOptions = TrajectoryExportOptions & { ghPath?: string };
export type TrajectoryShareResult = { gistUrl: string; shareUrl: string };

const DEFAULT_SHARE_VIEWER_URL = "https://vekexasia.github.io/pi-extensible-workflows/run.html";

function inlineAsset(html: string, tag: string, replacement: string): string {
  if (!html.includes(tag)) throw new Error(`Trajectory UI is missing the expected ${tag} reference`);
  // Replacer function: a string replacement would interpret $&, $`, and $' — sequences that occur in real transcripts — and duplicate the document.
  return html.replace(tag, () => replacement);
}

/**
 * Renders one persisted workflow run as a self-contained HTML document: the
 * live Trajectory UI with its scripts inlined and the run injected as static
 * state instead of a WebSocket connection.
 */
export async function exportTrajectoryRunHtml(options: TrajectoryExportOptions): Promise<string> {
  const home = options.home ?? homedir();
  const runs = await loadTrajectoryRuns(options.cwd, options.sessionId, home);
  const run = runs.find((candidate) => candidate.run.id === options.runId);
  if (!run) throw new Error(`Workflow run ${options.runId} was not found for session ${options.sessionId}`);
  const assets = new URL("./assets/", import.meta.url);
  const [html, marked, morphdom, mermaid, favicon] = await Promise.all([
    readFile(new URL("index.html", assets), "utf8"),
    readFile(new URL("marked.min.js", assets)),
    readFile(new URL("morphdom.min.js", assets)),
    readFile(new URL("mermaid.min.js", assets)),
    readFile(new URL("favicon.png", assets)),
  ]);
  const state = {
    type: "state",
    publishers: [{ id: `export-${options.runId}`, title: `run ${options.runId.slice(0, 8)}`, cwd: options.cwd, sessionId: options.sessionId, themes: true, connected: true, runs: [run], subagents: [] }],
    updatedAt: Date.now(),
  };
  // Base64 data URLs avoid </script> escaping issues inside inlined sources; JSON gets the standard \u003c escape.
  const script = (source: Buffer) => `<script src="data:text/javascript;base64,${source.toString("base64")}"></script>`;
  let output = html;
  output = inlineAsset(output, '<link rel="icon" type="image/png" href="./favicon.png" />', `<link rel="icon" type="image/png" href="data:image/png;base64,${favicon.toString("base64")}" />`);
  output = inlineAsset(output, '<script src="./marked.min.js"></script>', script(marked));
  output = inlineAsset(output, '<script src="./morphdom.min.js"></script>', script(morphdom));
  output = inlineAsset(output, '<script src="./mermaid.min.js"></script>', script(mermaid));
  output = inlineAsset(output, '<body data-view="run">', `<body data-view="run">\n  <script>window.__PIEWF_STATIC__ = ${JSON.stringify(state).replace(/</g, "\\u003c")};</script>`);
  return output;
}

function runGh(ghPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghPath, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new Error(notFound ? "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ and run `gh auth login`." : stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Exports one persisted run and uploads it as a secret GitHub gist through the
 * user's own `gh` CLI. Secret gists are unlisted, not private: anyone with the
 * link can read the full report.
 */
export async function shareTrajectoryRun(options: TrajectoryShareOptions): Promise<TrajectoryShareResult> {
  const html = await exportTrajectoryRunHtml(options);
  const directory = await mkdtemp(join(tmpdir(), "piewf-share-"));
  try {
    // The file name is the viewer's default (`run.html#<gistId>` loads trajectory.html).
    const file = join(directory, "trajectory.html");
    await writeFile(file, html);
    const stdout = await runGh(options.ghPath ?? "gh", ["gist", "create", "--public=false", file]);
    const gistUrl = stdout.trim().split("\n").pop() ?? "";
    const gistId = gistUrl.split("/").pop() ?? "";
    if (!/^[0-9a-f]+$/i.test(gistId)) throw new Error(`Could not parse the gist ID from gh output: ${stdout.trim()}`);
    const base = process.env.PIEWF_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
    return { gistUrl, shareUrl: `${base}#${gistId}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
