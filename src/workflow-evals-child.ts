import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureEvalCase, type CaptureCaseInput } from "./workflow-evals.js";

interface ChildInput { payload: CaptureCaseInput; outputPath: string }

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Missing eval child input path");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as ChildInput;
  const result = await captureEvalCase(input.payload);
  writeFileSync(input.outputPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });