#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorOptions } from "./doctor.js";
import { runSessionInspector } from "./session-inspector.js";

export interface CliOptions extends DoctorOptions { inspect?: (sessionId?: string) => Promise<void> }

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
  write("Usage: pi-extensible-workflows doctor | inspect [session-id]\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
