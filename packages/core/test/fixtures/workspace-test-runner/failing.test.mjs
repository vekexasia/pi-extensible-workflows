import assert from "node:assert/strict";
import test from "node:test";

void test("the selected failing fixture propagates its test failure", () => {
  assert.equal("expected", "deliberate runner failure");
});
