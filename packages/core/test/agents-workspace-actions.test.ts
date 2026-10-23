import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentsActionProvider } from "../src/agents-actions-contract.js";
import { runAgentsWorkspace } from "../src/agents-command.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import { registerWorkflowExtension, resetWorkflowRegistry, type AgentAttemptAction, type AgentAttemptActionUi } from "../src/index.js";
import { createPiActionUi } from "../src/pi-action-ui.js";
import { createSessionAgentsSource, type SessionAgentsSource, type SessionTreeNode } from "../src/session-agents.js";
import { createWorkflowActionProvider, type WorkflowActionDependencies } from "../src/workflow-actions.js";
import { createSubagentActionProvider, createSubagentPresenter } from "../subagents/src/actions.js";
import { agentRecord, choose, createRun, escapes, FakeSource, FakeView, fakePi, KEY, labelsOf, menuOf, POLLS, SESSION, settle, shown, statusRow, subagentFixture, timers, until, workflowFixture, workspaceOpen, type FakePi, type PendingCustom } from "./agents-workspace-harness.js";

/**
 * What only the whole wiring shows, for /workflow and /subagents: runAgentsWorkspace on the real workspace, the real session
 * source scoped as each opens it, the real providers and Pi's ActionUi adapter, over a fake Pi that shows one custom component
 * at a time (agents-workspace-harness.ts). Three cases stay: Pi's own custom overlay against the workspace's (Review), Pi's
 * editor dialog once the workspace stepped aside (Steer), and a registered action started detached, which never settles, fails
 * later or asks Pi later. The menus, labels, notices, reopening and in-place editors are asserted lower: on the providers in
 * workflow-actions.test.ts and subagent-actions.test.ts, on the loop in agents-loop.test.ts, on the workspace in
 * agents-workspace.test.ts and on the source in session-agents.test.ts.
 */

/** The command: the action loop over the real workspace, as /workflow and /subagents open it, with what it showed and asked. */
interface Command {
  readonly pi: FakePi;
  readonly done: Promise<void>;
  /** The agents whose transcript the workspace opened, by key, in order. */
  readonly opened: string[];
}
interface CommandOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly initialKey?: string;
  readonly editorCommand?: () => string | undefined;
}
/** Runs the loop until the case ends; then aborts the command, closes what Pi still shows and waits (bounded) for the command to end. */
function command(t: TestContext, cwd: string, options: CommandOptions, wiring: { readonly source: (ctx: ExtensionCommandContext) => SessionAgentsSource; readonly providers: (ctx: ExtensionCommandContext) => readonly AgentsActionProvider[]; readonly hasContent: (nodes: readonly SessionTreeNode[]) => boolean }): Command {
  const controller = new AbortController();
  const pi = fakePi({ columns: options.columns, rows: options.rows, signal: controller.signal, context: { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => SESSION }, isProjectTrusted: () => false } });
  const opened: string[] = [];
  const ctx = pi.ctx;
  const done = runAgentsWorkspace(ctx, {
    open: openAgentsWorkspace,
    options: {
      agents: wiring.source(ctx),
      openSource: (agent) => { opened.push(agent.key); return new FakeSource(agent.key); },
      createView: ({ ui, cwd: agentCwd }) => new FakeView(opened.at(-1) ?? "", ui, agentCwd),
      editorCommand: options.editorCommand ?? (() => undefined),
    },
    providers: wiring.providers(ctx),
    ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
    actionUi: (onNotify) => createPiActionUi(ctx, { onNotify }),
    hasContent: wiring.hasContent,
    // No case here leaves the session empty.
    onEmpty: () => undefined,
  });
  // A case that failed half way must not leave its loop holding the workspace for the next case.
  t.after(async () => {
    controller.abort();
    // Pi closes what it shows when the session ends; an action waiting on it then ends too.
    for (const custom of [...pi.customs]) custom.close();
    const ended = await Promise.race([done.then(() => true, () => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 2000); })]);
    assert.ok(ended, `the command ended after the case; Pi saw:\n${pi.events.join("\n")}`);
  });
  return { pi, done, opened };
}

/** The status row shows `notices`, joined as the workspace joins them and cut at the pane's width. */
function statusShows(pi: FakePi, notices: readonly string[]): void {
  const row = statusRow(pi);
  const expected = notices.join(" · ");
  assert.ok(row === expected || (row.endsWith("…") && expected.startsWith(row.slice(0, -1))), `status row ${JSON.stringify(row)} for ${JSON.stringify(expected)}`);
}
/** Runs a label that needs Pi's dialogs: what Pi saw from the workspace closing ("done") to it opening again on `title` ("custom"). */
async function stepAside(pi: FakePi, label: string, title: RegExp): Promise<string[]> {
  const mark = pi.events.length;
  await choose(pi, label);
  assert.equal(pi.events[mark], "done", "the workspace left before the action ran");
  await shown(pi, title);
  return pi.events.slice(mark);
}
/** The custom component an action shows once the workspace stepped aside. */
async function piCustom(pi: FakePi): Promise<PendingCustom> {
  await until(() => pi.customs.length === 1 && !workspaceOpen(pi), () => `Pi's custom component; Pi saw:\n${pi.events.join("\n")}`, POLLS);
  const custom = pi.customs[0];
  assert.ok(custom);
  return custom;
}
function press(custom: PendingCustom, ...keys: string[]): void { for (const key of keys) custom.component.handleInput?.(key); }
/** Leaves the workspace and checks that no dialog came over a pending custom and nothing escaped. */
async function finish(c: Command, escaped: readonly unknown[]): Promise<void> {
  await until(() => workspaceOpen(c.pi), "the workspace open to leave it", POLLS);
  c.pi.send(KEY.ctrlC);
  await c.done;
  assert.deepEqual(c.pi.violations, [], "no dialog over a pending custom component");
  assert.deepEqual(escaped, []);
}

// ---------------------------------------------------------------- /workflow

/** /workflow's workspace: its runs, the workflow provider, Pi's ActionUi. */
function workflows(t: TestContext, f: ReturnType<typeof workflowFixture>, options: CommandOptions = {}): Command {
  return command(t, f.cwd, options, {
    source: (ctx) => createSessionAgentsSource(ctx, { home: f.home, overlayRun: (run) => f.deps.liveAgents.overlay(run), liveAgent: () => undefined, subagents: () => undefined }, "workflows"),
    providers: (ctx) => [createWorkflowActionProvider(f.deps, ctx)],
    hasContent: (nodes) => nodes.length > 0,
  });
}
const STOP = "status workflow-stop -";

void test("/workflow: Review shows Pi's overlay only once the workspace left, and the workspace only once the overlay closed", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  const waiting = await createRun(f, "waiting", "awaiting_input");
  await waiting.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship it?", context: null });
  const c = workflows(t, f, { initialKey: "run:waiting" });
  const title = /^waiting-name waiting awaiting_input$/;
  await shown(c.pi, title);
  const mark = c.pi.events.length;
  await choose(c.pi, "Review ship");
  press(await piCustom(c.pi), KEY.down, KEY.enter);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", STOP, "custom"]);
  assert.deepEqual(f.calls, [["answerCheckpoint", "waiting", "ship", false, true]], "Reject");
  await finish(c, escaped);
});

/** Registered actions as Herdr's "Open live session": a pane that never hands back, one that fails later, one that asks Pi later; `contexts` the agents they ran on. */
function paneActions() {
  const late: { fail: (error: Error) => void; ask: () => void; say: (message: string) => void; finish: () => void; sayOther: (message: string) => void; finishOther: () => void; answers: boolean[]; contexts: string[] } = { fail: () => undefined, ask: () => undefined, say: () => undefined, finish: () => undefined, sayOther: () => undefined, finishOther: () => undefined, answers: [], contexts: [] };
  const action = (label: string, run: (context: { readonly agent: { readonly id: string }; readonly ui: AgentAttemptActionUi }) => Promise<void>): AgentAttemptAction => ({ label, visible: () => true, run, visibleStandalone: () => true, runStandalone: run });
  const actions: Record<string, AgentAttemptAction> = {
    pane: action("Open live session", async (context) => {
      late.contexts.push(context.agent.id);
      context.ui.setWorkingMessage?.("opening pane");
      context.ui.notify("pane opened");
      await new Promise<never>(() => undefined);
    }),
    work: action("Work later", async (context) => {
      late.say = (message) => { context.ui.setWorkingMessage?.(message); };
      await new Promise<void>((resolve) => { late.finish = resolve; });
    }),
    other: action("Work other", async (context) => {
      late.sayOther = (message) => { context.ui.setWorkingMessage?.(message); };
      await new Promise<void>((resolve) => { late.finishOther = resolve; });
    }),
    fail: action("Fail later", () => new Promise<void>((_resolve, reject) => { late.fail = reject; })),
    ask: action("Ask later", async (context) => {
      await new Promise<void>((resolve) => { late.ask = resolve; });
      late.answers.push(await context.ui.confirm("Again?", "Asked once the workspace opened again."));
    }),
  };
  return { actions, late };
}
/**
 * In the TUI workspace a registered action is started, not awaited: one that never settles leaves the workspace open and
 * taking keys and, once left, the next command opens it; a later failure is one notice, and a dialog asked once the workspace
 * is back is refused with one notice and never shown.
 */
async function detachedActions(t: TestContext, open: () => Command, title: RegExp, late: ReturnType<typeof paneActions>["late"]): Promise<void> {
  const escaped = escapes(t);
  // The pane never settles, and its working message lives per process: it must not show in the next test's workspace.
  t.after(() => { Reflect.deleteProperty(globalThis, Symbol.for("pi-extensible-workflows.agents-detached-ui")); });
  const c = open();
  await shown(c.pi, title);
  assert.deepEqual(await stepAside(c.pi, "Open live session", title), ["done", "working opening pane", "notify info: pane opened", STOP, "custom", "working -"], "the workspace opens again while the pane is open, and Pi's stale working message is cleared");
  statusShows(c.pi, ["opening pane", "pane opened"]);
  assert.ok(labelsOf(await menuOf(c.pi)).includes("Open live session"), "the workspace takes keys");
  c.pi.send(KEY.escape);
  await stepAside(c.pi, "Fail later", title);
  late.fail(new Error("pane closed"));
  const failure = "Agent attempt action failed: pane closed";
  await until(() => statusRow(c.pi).includes(failure), () => `the failure in the status row; Pi saw:\n${c.pi.events.join("\n")}`, POLLS);
  await stepAside(c.pi, "Ask later", title);
  c.pi.answers.confirm = () => true;
  late.ask();
  await until(() => late.answers.length === 1, "the dialog answered", POLLS);
  await settle();
  assert.deepEqual(late.answers, [false], "refused: answered as cancelled");
  assert.ok(statusRow(c.pi).includes("Refused \"Again?\": an action started from the agents workspace cannot use Pi's dialogs."), "the refusal in the status row");
  assert.deepEqual(c.pi.notified.filter((notice) => !notice.startsWith("info:")), [], "nothing of the open workspace's actions reaches Pi's chat");
  assert.equal(c.pi.events.some((event) => event.startsWith("confirm")), false, "Pi was never asked over the workspace");
  await finish(c, escaped);
  const next = open();
  await shown(next.pi, title);
  await finish(next, escaped);
}

/** A detached action's working message shows in the workspace's status row while it is pending, whatever the keys, and the row clears when it settles. */
async function detachedWorking(t: TestContext, open: () => Command, title: RegExp, late: ReturnType<typeof paneActions>["late"]): Promise<void> {
  const escaped = escapes(t);
  const c = open();
  await shown(c.pi, title);
  await stepAside(c.pi, "Work later", title);
  late.say("queued (waiting for a turn boundary)");
  await until(() => statusRow(c.pi).includes("queued (waiting for a turn boundary)"), () => `the working message in the status row; Pi saw:\n${c.pi.events.join("\n")}`, POLLS);
  assert.equal(c.pi.events.some((event) => event.startsWith("working queued")), false, "not Pi's working message while the workspace is open");
  late.say("opening pane");
  await until(() => statusRow(c.pi) === "opening pane", () => `the new message; row ${statusRow(c.pi)}`, POLLS);
  c.pi.send("z");
  assert.equal(statusRow(c.pi), "opening pane", "a key does not end it");
  // A second action takes the row; the first settling later does not clear the second's message.
  await stepAside(c.pi, "Work other", title);
  late.sayOther("second");
  await until(() => statusRow(c.pi) === "second", () => `the second message; row ${statusRow(c.pi)}`, POLLS);
  late.finish();
  await settle();
  assert.equal(statusRow(c.pi), "second", "the first action settling leaves the second's message");
  late.finishOther();
  await until(() => statusRow(c.pi) === "", () => `the row cleared once the action settled; row ${statusRow(c.pi)}`, POLLS);
  await finish(c, escaped);
}

void test("/workflow: a detached agent action's working message shows in the status row until it settles", async (t) => {
  timers(t);
  const { actions, late } = paneActions();
  const f = workflowFixture({ registry: { agentAttemptActions: () => actions } as unknown as WorkflowActionDependencies["registry"] });
  await createRun(f, "agents", "completed", { agents: [agentRecord("agent-1")] });
  await detachedWorking(t, () => workflows(t, f, { initialKey: "run:agents:agent-1" }), /^#1\/1 agent-1 completed/, late);
});

void test("/subagents: a detached standalone action's working message shows in the status row until it settles", async (t) => {
  timers(t);
  resetWorkflowRegistry();
  t.after(() => { resetWorkflowRegistry(); });
  const { actions, late } = paneActions();
  registerWorkflowExtension({ version: "1.0.0", headline: "Pane fixture", agentAttemptActions: actions });
  await detachedWorking(t, () => subagents(t, subagentFixture()), /^#1\/3 scout run-a running/, late);
});

void test("/workflow: a registered agent action is started detached: the workspace opens again at once, a later failure is one notice, a later dialog is refused", async (t) => {
  timers(t);
  const { actions, late } = paneActions();
  const f = workflowFixture({ registry: { agentAttemptActions: () => actions } as unknown as WorkflowActionDependencies["registry"] });
  await createRun(f, "agents", "completed", { agents: [agentRecord("agent-1")] });
  await detachedActions(t, () => workflows(t, f, { initialKey: "run:agents:agent-1", columns: 200 }), /^#1\/1 agent-1 completed/, late);
  assert.deepEqual(late.contexts, ["agent-1"]);
});

// ---------------------------------------------------------------- /subagents

/** /subagents' workspace: its subagents with the presenter's names and details, the subagent provider, Pi's ActionUi. */
function subagents(t: TestContext, s: ReturnType<typeof subagentFixture>, options: CommandOptions = {}): Command {
  return command(t, s.cwd, options, {
    source: (ctx) => createSessionAgentsSource(ctx, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => s.manager, subagentPresenter: () => createSubagentPresenter({ manager: s.manager, storageDirectory: s.directory }, ctx) }, "subagents"),
    providers: (ctx) => [createSubagentActionProvider({ manager: s.manager, storageDirectory: s.directory, clipboard: s.clipboard }, ctx)],
    hasContent: (nodes) => nodes.some((node) => node.agent !== undefined),
  });
}

void test("/subagents: Steer opens Pi's editor dialog once the workspace stepped aside", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture();
  const c = subagents(t, s);
  c.pi.answers.editor = () => "  check the docs\n";
  const title = /^#1\/3 scout run-a running/;
  await shown(c.pi, title);
  const events = await stepAside(c.pi, "Steer", title);
  assert.equal(events[1], "editor Steer subagent", "Pi's editor, the first thing Pi showed once the workspace left");
  assert.deepEqual(s.calls.map(([name, request]) => [name, request]), [["steer", { id: "run-a", message: "check the docs" }]]);
  statusShows(c.pi, ["Steered subagent run-a."]);
  await finish(c, escaped);
});

void test("/subagents: a registered standalone action is started detached: the workspace opens again at once, a later failure is one notice, a later dialog is refused", async (t) => {
  timers(t);
  resetWorkflowRegistry();
  t.after(() => { resetWorkflowRegistry(); });
  const { actions, late } = paneActions();
  registerWorkflowExtension({ version: "1.0.0", headline: "Pane fixture", agentAttemptActions: actions });
  const s = subagentFixture();
  await detachedActions(t, () => subagents(t, s, { columns: 200 }), /^#1\/3 scout run-a running/, late);
  assert.deepEqual(late.contexts, ["run-a"]);
});
