import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/validation.ts");


void test("static analysis reads AST property keys through one helper", () => {
  const source = readFileSync(validationPath, "utf8");
  assert.equal((source.match(/^function propertyKeyName\(/gm) ?? []).length, 1, "propertyKeyName() must be declared once");
  assert.equal((source.match(/key\.type === "Identifier" \? [\w.]+key\.name : [\w.]+key\.type === "Literal" \? String\([\w.]+key\.value\) : undefined/g) ?? []).length, 1, "the Identifier/Literal key ternary must live only inside propertyKeyName()");
});

void test("reserved instrumentation identifiers are rejected by one guard shared by instrumentation and preflight", () => {
  const source = readFileSync(validationPath, "utf8");
  assert.equal((source.match(/^function assertNoReservedIdentifiers\(/gm) ?? []).length, 1);
  assert.equal((source.match(/is reserved for workflow \$\{[^}]+\} instrumentation/g) ?? []).length, 1, "the reservation message must be produced in one place");
  assert.equal((source.match(/assertNoReservedIdentifiers\(program\)/g) ?? []).length, 2, "instrumentWorkflow() and preflight() must both call the guard");
  assert.doesNotMatch(source, /function staticRoleName\(/, "staticRoleName duplicated staticString");
});
