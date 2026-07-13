#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorOptions } from "./doctor.js";

export async function runCli(args: readonly string[], options: DoctorOptions = {}, write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  if (args[0] !== "doctor" || args.length !== 1) {
    write("Usage: pi-workflows doctor\n");
    return 1;
  }
  const report = await doctor(options);
  write(formatDoctorReport(report));
  return doctorExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
