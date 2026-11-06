import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const promptNames = ["odd-tasks.md", "work-unit-commits.md", "skill-usage.md"] as const;

void test("starter retainer prompts are complete and subordinate to starter policy", () => {
  for (const name of promptNames) {
    const path = new URL(`../../starter/prompts/${name}`, import.meta.url);
    assert.equal(existsSync(path), true, `${name}: missing`);
    const source = readFileSync(path, "utf8");
    assert.notEqual(source.trim(), "", `${name}: empty`);
    const lastLine = source.trimEnd().split("\n").at(-1) ?? "";
    assert.match(lastLine, /[.!?]$/, `${name}: truncated mid-sentence`);
    assert.doesNotMatch(source, /choose (a|the) skill|pick a skill/i, `${name}: chooses its own skills`);
  }

  const skillUsage = readFileSync(new URL("../../starter/prompts/skill-usage.md", import.meta.url), "utf8");
  assert.match(skillUsage, /Which skills a unit receives is decided by `context-policy\.ts` and passed in the agent call\./);
});
