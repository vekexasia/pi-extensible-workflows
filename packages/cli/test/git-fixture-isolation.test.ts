import test from "node:test";
// Shared test support is deliberately outside Core's published production API.
const { assertGitFixturesIsolated } = await import(new URL("../test/git-fixture-isolation.js", import.meta.resolve("pi-extensible-workflows")).href) as typeof import("../../core/dist/test/git-fixture-isolation.js");

void test("direct CLI fixtures ignore a synthetic hostile HOME and signing policy", { timeout: 60_000 }, () => {
  assertGitFixturesIsolated([{ url: new URL("./doctor-cleanup.test.js", import.meta.url), pattern: "preserves a real borrowed worktree", count: 1 }]);
});
