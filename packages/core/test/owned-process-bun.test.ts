import { execFileSync } from "node:child_process";
import { registerOwnedProcessRuntime } from "./owned-process-fixture.js";

let bun: string | undefined;
try {
  bun = execFileSync("which", ["bun"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch { /* Bun is optional; Node is required. */ }
if (bun !== undefined && bun !== process.execPath) registerOwnedProcessRuntime({ name: "Bun", executable: bun });
