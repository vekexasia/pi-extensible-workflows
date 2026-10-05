import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

void test("selection fixture records that it ran", () => {
  appendFileSync(process.env.RUNNER_TEST_LOG, `${basename(fileURLToPath(import.meta.url))}\n`);
});
