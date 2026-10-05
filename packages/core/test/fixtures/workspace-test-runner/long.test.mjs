import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import test from "node:test";

void test("a cancelled worker owns and starts its descendant", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  writeFileSync(process.env.RUNNER_TEST_MARKER, JSON.stringify({ workerHome: process.env.HOME, childPid: child.pid }));
  await new Promise(() => {});
});
