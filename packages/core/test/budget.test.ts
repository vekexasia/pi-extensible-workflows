import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { budgetRelaxed, createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, mergeBudget, registerWorkflowExtension, resumeBudgetAllowed, RunStore, validateBudget, validateBudgetPatch, WorkflowAgentExecutor, WorkflowBudgetRuntime, WORKFLOW_BUDGET_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WorkflowError } from "../src/index.js";
import { loadingRegistry } from "../src/registry.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession, type TestPiSessionEvent } from "./test-transport.js";

void test("validates aggregate budgets and patches", () => {
  const budget = validateBudget({ tokens: { soft: 5, hard: 10 }, costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.deepEqual(budget, { tokens: { soft: 5, hard: 10 }, costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.throws(() => validateBudget({ tokens: { soft: -1 } }), /non-negative/);
  assert.throws(() => validateBudget({ tokens: { soft: 2, hard: 2 } }), /less than hard/);
  assert.deepEqual(validateBudgetPatch({ tokens: null, costUsd: { hard: 3 } }), { tokens: null, costUsd: { hard: 3 } });
  assert.deepEqual(mergeBudget(budget, { tokens: null }), { costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.equal(budgetRelaxed(budget, mergeBudget(budget, { costUsd: { hard: 4 } })), true);
  assert.equal(resumeBudgetAllowed({ tokens: { hard: 5 } }, { tokens: 5, costUsd: 0, durationMs: 0, agentLaunches: 0 }), false);
});
void test("budget runtime excludes cache tokens, records soft crossings, and tracks active duration", () => {
  let now = 0;
  const runtime = new WorkflowBudgetRuntime({ tokens: { soft: 5, hard: 10 }, costUsd: { hard: 1 }, durationMs: { hard: 20 }, agentLaunches: { hard: 1 } }, 1, undefined, [], { now: () => now });
  const agent = runtime.forAgent("agent");
  agent.beforeAttempt();
  agent.afterTurn({ input: 2, output: 3, cacheRead: 100, cacheWrite: 100, cost: 0.5 }, true);
  assert.deepEqual(runtime.usage, { tokens: 5, costUsd: 0.5, durationMs: 0, agentLaunches: 1 });
  assert.equal(runtime.events[0]?.type, "soft_crossed");
  assert.match(agent.instruction() ?? "", /Finish the requested output/);
  now = 21;
  assert.throws(() => { agent.beforeTurn(); }, (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
});
type BudgetMessage = { role: string; content: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
type BudgetResponse = { content: unknown; usage?: BudgetMessage["usage"] };

function budgetUsage(input: number, output: number, cost = 0): NonNullable<BudgetMessage["usage"]> { return { input, output, cacheRead: 100, cacheWrite: 200, cost: { total: cost } }; }

function budgetMessageEvent(type: "message_start" | "message_end", message: BudgetMessage): TestPiSessionEvent { return { type, message }; }

function budgetSession(responses: readonly BudgetResponse[], steered: string[] = [], aborted = { value: false }): TestPiSession {
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  let responseIndex = 0;
  const messages: BudgetMessage[] = [];
  return {
    sessionId: `budget-session-${String(Math.random())}`,
    sessionFile: "/sessions/budget.jsonl",
    messages,
    getSessionStats() {
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let cost = 0;
      for (const message of messages) {
        const usage = message.usage;
        if (!usage) continue;
        tokens.input += usage.input; tokens.output += usage.output; tokens.cacheRead += usage.cacheRead; tokens.cacheWrite += usage.cacheWrite; cost += usage.cost.total;
      }
      return { tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite }, cost };
    },
    subscribe(candidate) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() {
      while (responseIndex < responses.length && !aborted.value) {
        const response = responses[responseIndex++];
        if (!response) throw new Error("No mock response");
        const start = { role: "assistant", content: response.content };
        listener?.(budgetMessageEvent("message_start", start));
        const message = { ...start, ...(response.usage ? { usage: response.usage } : {}) };
        messages.push(message);
        listener?.(budgetMessageEvent("message_end", message));
      }
    },
    async steer(message) { steered.push(message); },
    async abort() { aborted.value = true; },
    dispose() {},
  };
}

function budgetExecutor(session: TestPiSession): WorkflowAgentExecutor {
  return new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, testTransport(async () => session));
}

void test("budget validation covers zero, all dimensions, and invalid patches", () => {
  assert.deepEqual(validateBudget({ tokens: { soft: 0, hard: 1 }, costUsd: { soft: 0, hard: 0.5 }, durationMs: { soft: 0, hard: 1 }, agentLaunches: { soft: 0, hard: 1 } }), { tokens: { soft: 0, hard: 1 }, costUsd: { soft: 0, hard: 0.5 }, durationMs: { soft: 0, hard: 1 }, agentLaunches: { soft: 0, hard: 1 } });
  for (const dimension of ["tokens", "durationMs", "agentLaunches"] as const) {
    assert.throws(() => validateBudget({ [dimension]: { hard: 1.5 } }), /integer/);
  }
  assert.throws(() => validateBudget({ costUsd: { hard: Infinity } }), /finite/);
  assert.throws(() => validateBudget({ tokens: { soft: null } }), /non-negative/);
  assert.throws(() => validateBudget({ tokens: { hard: 1 }, extra: { hard: 2 } }), /Unknown budget dimension/);
  assert.throws(() => validateBudgetPatch({ tokens: { soft: 2, hard: 2 } }), /less than hard/);
  assert.throws(() => validateBudgetPatch({ tokens: { hard: "later" } }), /integer/);
});
void test("navigator budget resume and approval use the live trust context", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-budget-aliases-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "reviewer-model": "project/model" } }));
  const runId = "navigator-budget-run";
  const budget = { tokens: { hard: 4 } };
  const usage = { tokens: 4, costUsd: 0, durationMs: 0, agentLaunches: 1 };
  const store = new RunStore(cwd, "session", runId, home);
  await store.create({ id: runId, workflowName: "navigator-budget", cwd, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [], budget, budgetVersion: 1, usage }, createLaunchSnapshot({ script: "return await agent('work', { model: 'reviewer-model' });", args: null, metadata: { name: "navigator-budget" }, settings: { concurrency: 1, modelAliases: { "reviewer-model": "old/model" } }, modelAliases: { "reviewer-model": "old/model" }, models: ["openai/gpt", "old/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let resolverCalls = 0;
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "navigator-budget-session", locator: { sessionFile: "/sessions/navigator-budget.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, testTransport(createSession), agentDir);
  registerWorkflowExtension({ version: "1.0.0", headline: "Navigator policy", modelAliases: { "reviewer-model": { resolve(context) { resolverCalls += 1; assert.equal(context.projectTrusted, false); assert.ok(context.availableModels.has("new/model")); return "new/model"; } } } });
  const context = { cwd, hasUI: false, isProjectTrusted: () => false, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }, { provider: "new", id: "model" }], getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "new", id: "model" }] }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  const resume = tools.find(({ name }) => name === "workflow_resume");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(start && resume && respond && shutdown);
  await start({}, context);
  await resume.execute("id", { runId, budget: { tokens: { hard: 10 } }, foreground: false }, undefined, undefined, context);
  const proposal = (await store.pendingWorkflowDecisions())[0];
  assert.ok(proposal);
  await respond.execute("id", { runId, proposalId: proposal.proposalId, approved: true }, undefined, undefined, context);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed", JSON.stringify(loaded.run.error));
  assert.equal(resolverCalls, 1);
  assert.deepEqual(loaded.snapshot.modelAliases, { "reviewer-model": "new/model" });
  loadingRegistry().freeze();
  await shutdown();
});
void test("budget runtime aggregates nested attempts, retries, cache exclusion, and versioned soft events", () => {
  let now = 0;
  const limits = { tokens: { soft: 3, hard: 100 }, costUsd: { soft: 0.5, hard: 100 }, durationMs: { soft: 4, hard: 100 }, agentLaunches: { soft: 1, hard: 10 } };
  const runtime = new WorkflowBudgetRuntime(limits, 1, undefined, [], { now: () => now });
  const parent = runtime.forAgent("parent");
  parent.beforeAttempt();
  parent.afterTurn({ input: 1, output: 1, cacheRead: 50, cacheWrite: 50, cost: 0.25 }, true);
  parent.beforeAttempt();
  parent.afterTurn({ input: 2, output: 2, cacheRead: 500, cacheWrite: 500, cost: 0.75 }, true);
  const child = runtime.forAgent("parent:child");
  child.beforeAttempt();
  child.afterTurn({ input: 1, output: 0, cacheRead: 999, cacheWrite: 999, cost: 0.1 }, true);
  assert.deepEqual(runtime.usage, { tokens: 7, costUsd: 1.1, durationMs: 0, agentLaunches: 3 });
  assert.equal(runtime.events.filter((event) => event.budgetVersion === 1 && event.type === "soft_crossed").length, 1);
  assert.ok(parent.instruction());
  assert.equal(parent.instruction(), undefined);
  assert.ok(child.instruction());
  runtime.transition("paused");
  now = 100;
  assert.equal(runtime.usage.durationMs, 0);
  runtime.transition("running");
  now = 104;
  assert.equal(runtime.usage.durationMs, 4);
  const next = new WorkflowBudgetRuntime(limits, 2, runtime.usage, runtime.events, { now: () => now, active: false });
  assert.equal(next.events.filter((event) => event.budgetVersion === 2).length, 0);
  assert.ok(next.forAgent("later").instruction());
});

void test("agent launch budgets are checked at the concurrent dispatch boundary", async () => {
  const runtime = new WorkflowBudgetRuntime({ agentLaunches: { hard: 1 } });
  const scheduler = new FairAgentScheduler(async ({ id }) => { runtime.forAgent(id).beforeAttempt(); return id; }, 2);
  scheduler.addRun("budget", 2, () => { runtime.checkAgentLaunch(); });
  const first = scheduler.spawn("budget", "first", { label: "first", cwd: "/repo", tools: [] });
  const second = scheduler.spawn("budget", "second", { label: "second", cwd: "/repo", tools: [] });
  assert.equal((await first.result).ok, true);
  const rejected = await second.result;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "BUDGET_EXHAUSTED");
  assert.equal(runtime.usage.agentLaunches, 1);
});

void test("agent executor injects soft guidance and preserves final overrun but cuts off non-final work", async () => {
  const guidance: string[] = [];
  const soft = new WorkflowBudgetRuntime({ tokens: { soft: 1, hard: 100 } });
  const softSession = budgetSession([
    { content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], usage: budgetUsage(1, 1) },
    { content: [{ type: "text", text: "done" }], usage: budgetUsage(2, 2) },
  ], guidance);
  const softResult = await budgetExecutor(softSession).execute("soft", { label: "soft", workflowName: "budget", budget: soft.forAgent("soft") });
  assert.equal(softResult.value, "done");
  assert.equal(guidance.length, 1);
  assert.match(guidance[0] ?? "", /Finish the requested output/);

  const finalRuntime = new WorkflowBudgetRuntime({ tokens: { hard: 1 } });
  const final = await budgetExecutor(budgetSession([{ content: [{ type: "text", text: "accepted" }], usage: budgetUsage(2, 0) }])).execute("final", { label: "final", workflowName: "budget", budget: finalRuntime.forAgent("final") });
  assert.equal(final.value, "accepted");
  assert.equal(finalRuntime.events.at(-1)?.type, "hard_overrun");
  assert.equal(finalRuntime.hardExhausted, false);

  const aborted = { value: false };
  const nonFinalRuntime = new WorkflowBudgetRuntime({ tokens: { hard: 1 } });
  const nonFinalSession = budgetSession([{ content: [{ type: "toolCall", id: "tool-2", name: "read", arguments: {} }], usage: budgetUsage(2, 0) }], [], aborted);
  await assert.rejects(budgetExecutor(nonFinalSession).execute("non-final", { label: "non-final", workflowName: "budget", budget: nonFinalRuntime.forAgent("non-final") }), (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
  assert.equal(aborted.value, true);
  assert.equal(nonFinalRuntime.hardExhausted, true);
});

void test("budget persistence retains usage, versions, events, and replay history across reload", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-persistence-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const budget = { tokens: { soft: 2, hard: 4 }, costUsd: { hard: 1 } };
  const usage = { tokens: 4, costUsd: 1.2, durationMs: 8, agentLaunches: 2 };
  const event = { type: "hard_exhausted" as const, budgetVersion: 1, dimensions: ["tokens"] as const, usage, limits: budget, at: 8 };
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "budget" }, settings: DEFAULT_SETTINGS, budget, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "budget", cwd, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [], budget, budgetVersion: 1, usage, budgetEvents: [event] }, snapshot);
  await store.complete("agent/replayed", "historical");
  const reloaded = await new RunStore(cwd, "session", "run", home).load();
  assert.deepEqual(reloaded.run.usage, usage);
  assert.deepEqual(reloaded.run.budget, budget);
  assert.deepEqual(reloaded.run.budgetEvents, [event]);
  assert.deepEqual(await new RunStore(cwd, "session", "run", home).replay("agent/replayed"), { path: "agent/replayed", value: "historical" });
});

void test("completed final overruns complete, while later budgeted work reaches budget_exhausted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-boundaries-"));
  const cwd = join(home, "project");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let sessionCount = 0;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], }), home, async () => {}, testTransport(async () => { sessionCount += 1; return budgetSession([{ content: [{ type: "text", text: "done" }], usage: budgetUsage(2, 0) }]); }));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const completed = await workflow.execute("id", { name: "final-overrun", script: "return await agent('one');", budget: { tokens: { hard: 1 } }, foreground: true }, new AbortController().signal, undefined, context);
  const completedRun = (await new RunStore(cwd, "session", (await listRunIds(cwd, "session", home))[0] ?? "", home).load()).run;
  assert.equal(completedRun.state, "completed");
  assert.equal(completedRun.budgetEvents?.filter(({ type }) => type === "hard_overrun").length, 1);
  assert.match(JSON.stringify(completed), /done/);
  const second = workflow.execute("id", { name: "exhausted", script: "return {one: await agent('one'), two: await agent('two')};", budget: { tokens: { hard: 1 } }, foreground: true }, new AbortController().signal, undefined, context);
  await assert.rejects(second, (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
  const states = await Promise.all((await listRunIds(cwd, "session", home)).map(async (id) => (await new RunStore(cwd, "session", id, home).load()).run));
  const exhausted = states.find((run) => run.state === "budget_exhausted");
  assert.ok(exhausted);
  assert.equal(exhausted.error?.code, "BUDGET_EXHAUSTED");
  assert.ok(sessionCount >= 2);
});

void test("workflow_resume preserves replacement budget accounting through terminal persistence", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-resume-"));
  const cwd = join(home, "project");
  const runId = "budget-run";
  const budget = { tokens: { soft: 2, hard: 4 } };
  const usage = { tokens: 4, costUsd: 0, durationMs: 0, agentLaunches: 1 };
  const exhausted = { type: "hard_exhausted" as const, budgetVersion: 1, dimensions: ["tokens"] as const, usage, limits: budget, at: 0 };
  const store = new RunStore(cwd, "session", runId, home);
  await store.create({ id: runId, workflowName: "resume-budget", cwd, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [], budget, budgetVersion: 1, usage, budgetEvents: [exhausted] }, createLaunchSnapshot({ script: "return await agent('work');", args: null, metadata: { name: "resume-budget" }, launchMode: "foreground", settings: { concurrency: 1 }, budget, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const events: Array<{ channel: string; data: unknown }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } }), home, undefined, testTransport(async () => budgetSession([{ content: [{ type: "text", text: "done" }], usage: budgetUsage(2, 0) }])), agentDir);
  let resolverCalls = 0;
  registerWorkflowExtension({ version: "1.0.0", headline: "Budget model policy", modelAliases: { "reviewer-model": { resolve(context) { resolverCalls += 1; assert.equal(context.projectTrusted, false); assert.ok(context.availableModels.has("new/model")); return "new/model"; } } } });
  const context = { cwd, model: { provider: "openai", id: "gpt" }, isProjectTrusted: () => false, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }, { provider: "new", id: "model" }], getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "new", id: "model" }] }, sessionManager: { getSessionId: () => "session" } };
  assert.ok(start && shutdown);
  await start({}, context);
  const resume = tools.find(({ name }) => name === "workflow_resume");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(resume && respond);
  await assert.rejects(resume.execute("id", { runId: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await assert.rejects(resume.execute("id", { runId, budget: { tokens: { hard: 4 } } }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /exhausted hard budget/.test(error.message));
  const rejectedResume = await resume.execute("id", { runId, budget: { tokens: { hard: 10 } } }) as { details: { state: string; proposalId: string } };
  const firstProposal = (await store.pendingWorkflowDecisions())[0];
  assert.ok(firstProposal);
  assert.deepEqual(firstProposal, { kind: "budget", proposalId: rejectedResume.details.proposalId, runId, consumed: usage, previous: budget, proposed: { tokens: { soft: 2, hard: 10 } }, budgetVersion: 1 });
  assert.deepEqual(rejectedResume.details, { state: "awaiting_approval", proposalId: firstProposal.proposalId });
  const wrong = await respond.execute("id", { runId, proposalId: "wrong-proposal", approved: true });
  assert.deepEqual((wrong as { details: unknown }).details, { state: "budget_exhausted", approved: false, reason: "proposal_not_pending" });
  const rejected = await respond.execute("id", { runId, proposalId: firstProposal.proposalId, approved: false });
  assert.deepEqual((rejected as { details: unknown }).details, { state: "budget_exhausted", approved: false, reason: "rejected" });
  assert.equal((await store.load()).run.state, "budget_exhausted");
  const approvedResume = await resume.execute("id", { runId, budget: { tokens: { hard: 10 } } }) as { details: { state: string; proposalId: string } };
  const secondProposal = (await store.pendingWorkflowDecisions())[0];
  assert.ok(secondProposal);
  assert.deepEqual(approvedResume.details, { state: "awaiting_approval", proposalId: secondProposal.proposalId });
  const approved = await respond.execute("id", { runId, proposalId: secondProposal.proposalId, approved: true }, new AbortController().signal, undefined, context);
  const approvedDetails = (approved as { details: { state: string; approved: boolean; reason: string; value?: unknown } }).details;
  assert.equal(approvedDetails.state, "completed");
  assert.equal(approvedDetails.approved, true);
  assert.equal(approvedDetails.reason, "approved");
  assert.equal(approvedDetails.value, "done");
  const approvedContent = JSON.parse((approved as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as { state: string; approved: boolean; runId: string; value: { state: string; runId: string; resultPath: string; resultBytes: number; inlined: boolean } };
  assert.equal(approvedContent.state, "completed");
  assert.equal(approvedContent.approved, true);
  assert.equal(approvedContent.runId, runId);
  assert.equal(approvedContent.value.state, "completed");
  assert.equal(approvedContent.value.runId, runId);
  assert.match(approvedContent.value.resultPath, /result\.json$/);
  assert.equal(approvedContent.value.inlined, false);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed");
  assert.equal(loaded.run.budgetVersion, 2);
  assert.deepEqual(loaded.run.budget, { tokens: { soft: 2, hard: 10 } });
  assert.ok(loaded.run.usage);
  assert.equal(loaded.run.usage.tokens, 6);
  assert.equal(loaded.run.usage.agentLaunches, 2);
  assert.ok(loaded.run.budgetEvents);
  assert.equal(loaded.run.budgetEvents.some((event) => event.budgetVersion === 1 && event.type === "soft_crossed"), false);
  assert.ok(loaded.run.budgetEvents.some((event) => event.budgetVersion === 2 && event.type === "soft_crossed"));
  assert.deepEqual(loaded.snapshot.modelAliases, { "reviewer-model": "new/model" });
  assert.equal(resolverCalls, 1);
  assert.equal(events.filter(({ channel }) => channel === WORKFLOW_RUN_STARTED_EVENT).length, 0);
  assert.equal(events.filter(({ channel }) => channel === WORKFLOW_RUN_RESUMED_EVENT).length, 1);
  assert.deepEqual(events.filter(({ channel }) => channel === WORKFLOW_BUDGET_EVENT).map(({ data }) => (data as { type: string }).type), ["adjustment_requested", "adjustment_rejected", "adjustment_requested", "adjustment_approved", "soft_crossed"]);
  assert.ok(events.some(({ channel, data }) => channel === WORKFLOW_RUN_STATE_CHANGED_EVENT && (data as { state: string }).state === "running"));
  loadingRegistry().freeze();
  await shutdown();
});
