import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function readPrompt(name: string): string {
  const path = new URL(`../../starter/prompts/${name}`, import.meta.url);
  assert.equal(existsSync(path), true, `${name}: missing`);
  const source = readFileSync(path, "utf8");
  const nonBlankLines = source.split("\n").filter((line) => line.trim() !== "").length;
  assert.ok(nonBlankLines >= 8, `${name}: only ${String(nonBlankLines)} non-blank lines`);
  const lastLine = source.trimEnd().split("\n").at(-1) ?? "";
  assert.match(lastLine, /[.!?]$/, `${name}: truncated mid-sentence`);
  return source;
}

const choosesSkills = /(choose|pick|select|rank)[^.]{0,40}skills?/i;

void test("odd-tasks.md tracks a multi-step unit with a task document", () => {
  const source = readPrompt("odd-tasks.md");
  assert.match(source, /task/i, "odd-tasks.md: does not track tasks");
  assert.match(source, /track/i, "odd-tasks.md: does not track tasks");
  assert.doesNotMatch(source, choosesSkills, "odd-tasks.md: chooses its own skills");
});

void test("work-unit-commits.md slices work into reviewable commits", () => {
  const source = readPrompt("work-unit-commits.md");
  assert.match(source, /commit/i, "work-unit-commits.md: does not slice commits");
  assert.match(source, /slice/i, "work-unit-commits.md: does not slice commits");
  assert.doesNotMatch(source, choosesSkills, "work-unit-commits.md: chooses its own skills");
});

void test("skill-usage.md follows supplied skills and defers to context policy", () => {
  const source = readPrompt("skill-usage.md");
  assert.match(source, /skill_resolution: none/, "skill-usage.md: does not report a missing skill");
  assert.match(source, /context policy/, "skill-usage.md: does not describe the context policy");
});
