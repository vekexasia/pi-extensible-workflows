#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorOptions } from "./doctor.js";
import { runSessionInspector, transcriptFileLines } from "./session-inspector.js";

export interface CliOptions extends DoctorOptions { inspect?: (sessionId?: string) => Promise<void>; transcript?: (sessionFile: string) => Promise<void> }

export async function runCli(args: readonly string[], options: CliOptions = {}, write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  if (args[0] === "doctor" && args.length === 1) {
    const report = await doctor(options);
    write(formatDoctorReport(report));
    return doctorExitCode(report);
  }
  if (args[0] === "inspect" && args.length <= 2) {
    try { await (options.inspect ?? runSessionInspector)(args[1]); return 0; }
    catch (error) { write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  if (args[0] === "transcript" && args.length === 2) {
    try {
      if (options.transcript) await options.transcript(args[1] as string);
      else write(`${transcriptFileLines(args[1] as string).join("\n")}\n`);
      return 0;
    } catch (error) { write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  write("Usage: pi-extensible-workflows doctor | inspect [session-id]\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
