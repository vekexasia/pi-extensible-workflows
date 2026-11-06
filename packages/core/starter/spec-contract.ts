export interface SpecRequirement {
  id: string;
  statement: string;
}

export type SpecVerdictValue = "pass" | "fail" | "unverified";

export interface SpecVerdict {
  requirementId: string;
  verdict: SpecVerdictValue;
  evidence: readonly string[];
}

const sectionHeading = /^##(?!#)(?:\s|$)/;

function sectionLines(markdown: string, name: string): { lines: string[]; startLine: number } | undefined {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (headingIndex < 0) return undefined;
  const endIndex = lines.findIndex((line, index) => index > headingIndex && sectionHeading.test(line.trim()));
  return { lines: lines.slice(headingIndex + 1, endIndex < 0 ? lines.length : endIndex), startLine: headingIndex + 2 };
}

export function parseSpecDocument(markdown: string): SpecRequirement[] {
  const section = sectionLines(markdown, "Specs");
  if (!section) return [];

  const requirements: SpecRequirement[] = [];
  const seen = new Set<string>();
  for (const [index, line] of section.lines.entries()) {
    const lineNumber = section.startLine + index;
    if (line.trim() === "") continue;
    const match = /^(S\d+)[.):]\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid spec line ${String(lineNumber)}: expected an S-id requirement`);
    const [, id, rawStatement] = match;
    if (!id || !rawStatement?.trim()) throw new Error(`Empty statement for ${id ?? "spec"} on line ${String(lineNumber)}`);
    if (seen.has(id)) throw new Error(`Duplicate spec id ${id} on line ${String(lineNumber)}`);
    seen.add(id);
    requirements.push({ id, statement: rawStatement.trim() });
  }

  if (requirements.length === 0) throw new Error("## Specs section has no requirements");
  return requirements;
}

export function parseTaskSpecLinks(markdown: string): { taskId: string; specIds: string[] }[] {
  const section = sectionLines(markdown, "Tasks");
  if (!section) return [];

  const tasks: { taskId: string; specIds: string[] }[] = [];
  for (const [index, line] of section.lines.entries()) {
    if (!line.includes("Spec:")) continue;
    const lineNumber = section.startLine + index;
    const taskId = line.trim().split(/\s+/, 1)[0] ?? "";
    const specIds = line.slice(line.indexOf("Spec:") + "Spec:".length).split(",").map((id) => id.trim()).filter(Boolean);
    const seen = new Set<string>();
    for (const specId of specIds) {
      if (seen.has(specId)) throw new Error(`Duplicate spec id ${specId} in task ${taskId} on line ${String(lineNumber)}`);
      seen.add(specId);
    }
    tasks.push({ taskId, specIds });
  }
  return tasks;
}

export function validateSpecCoverage(
  spec: readonly SpecRequirement[],
  tasks: readonly { taskId: string; specIds: readonly string[] }[],
  verdicts: readonly SpecVerdict[],
): { ok: boolean; problems: string[] } {
  const specIds = new Set(spec.map(({ id }) => id));
  const verdictIds = new Set(verdicts.map(({ requirementId }) => requirementId));
  const problems: string[] = [];

  for (const task of tasks) {
    const existingSpecIds = task.specIds.filter((specId) => specIds.has(specId));
    if (existingSpecIds.length === 0) problems.push(`Task ${task.taskId} references no existing spec id.`);
    for (const specId of task.specIds) {
      if (!specIds.has(specId)) problems.push(`Task ${task.taskId} references unknown spec id ${specId}.`);
    }
  }

  for (const specId of specIds) {
    if (!tasks.some((task) => task.specIds.includes(specId))) problems.push(`Spec ${specId} is referenced by no task.`);
    if (!verdictIds.has(specId)) problems.push(`Spec ${specId} has no verdict.`);
  }

  for (const verdict of verdicts) {
    if (!specIds.has(verdict.requirementId)) problems.push(`Verdict references unknown spec id ${verdict.requirementId}.`);
  }

  return { ok: problems.length === 0, problems };
}
