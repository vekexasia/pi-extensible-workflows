import type { ContextFileScope } from "../src/types.js";

export type StarterRole = "developer" | "reviewer" | "researcher" | "scout" | "oracle";

export interface ContextPolicy {
  readonly role: StarterRole;
  readonly contextFiles: readonly ContextFileScope[];
  readonly skills: readonly string[];
}

export const CONTEXT_POLICIES: Readonly<Record<StarterRole, ContextPolicy>> = {
  developer: {
    role: "developer",
    // Developers need global, project, and cwd instructions to implement safely in the active worktree.
    contextFiles: ["global", "project", "cwd"],
    skills: ["engineering-excellence", "tigerstyle", "typescript-advanced"],
  },
  reviewer: {
    role: "reviewer",
    // Reviewers inspect the repository and diff directly, so cwd-local instructions are not needed.
    contextFiles: ["global", "project"],
    skills: ["code-review", "tigerstyle"],
  },
  researcher: {
    role: "researcher",
    // Researchers need repository guidance while their evidence comes from explicit files and tools.
    contextFiles: ["global", "project"],
    skills: ["research", "reusable-data-search"],
  },
  scout: {
    role: "scout",
    // Scouts need repository guidance while their read-only recon uses explicit paths and tools.
    contextFiles: ["global", "project"],
    skills: ["ponytail"],
  },
  oracle: {
    role: "oracle",
    // Oracles challenge proposals against explicit source evidence, so cwd-local instructions are not needed.
    contextFiles: ["global", "project"],
    skills: ["grill-me"],
  },
};

export function contextPolicyFor(role: string): ContextPolicy {
  if (Object.hasOwn(CONTEXT_POLICIES, role)) return CONTEXT_POLICIES[role as StarterRole];
  throw new Error(`Unknown starter role: ${role}`);
}

export function missingSkillPaths(
  policies: readonly ContextPolicy[],
  installed: (skill: string) => string | undefined,
): { role: string; skill: string }[] {
  return policies.flatMap((policy) => policy.skills.filter((skill) => installed(skill) === undefined).map((skill) => ({ role: policy.role, skill })));
}
