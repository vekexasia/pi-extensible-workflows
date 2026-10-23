import { rawKeyHint, truncateToVisualLines, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi } from "./agents-actions-contract.js";
import { formatCheckpointReview } from "./host-view.js";
import { object, sanitizeDisplayText } from "./utils.js";
import { confirmWithBlocked, type ReportBlocked } from "./workflow-actions.js";

type UiSelect = (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
type UiInput = (title: string, placeholder?: string) => Promise<string | undefined>;
type UiSetStatus = (key: string, text?: string) => void;
type UiCustom = ExtensionUIContext["custom"];
type UiHostCapabilities = { select?: UiSelect; input?: UiInput; setStatus?: UiSetStatus; custom?: UiCustom };
function isUiSelect(value: unknown): value is UiSelect { return typeof value === "function"; }
function isUiInput(value: unknown): value is UiInput { return typeof value === "function"; }
function isUiSetStatus(value: unknown): value is UiSetStatus { return typeof value === "function"; }
function isUiCustom(value: unknown): value is UiCustom { return typeof value === "function"; }
function isCheckpointDecision(value: unknown): value is "Approve" | "Reject" { return value === "Approve" || value === "Reject"; }
export function uiHostCapabilities(ui: unknown): UiHostCapabilities | undefined {
  if (!object(ui)) return undefined;
  const selectValue = ui.select;
  const inputValue = ui.input;
  const setStatusValue = ui.setStatus;
  const customValue = ui.custom;
  const select = isUiSelect(selectValue) ? selectValue.bind(ui) : undefined;
  const input = isUiInput(inputValue) ? inputValue.bind(ui) : undefined;
  const setStatus = isUiSetStatus(setStatusValue) ? setStatusValue.bind(ui) : undefined;
  const custom = isUiCustom(customValue) ? customValue.bind(ui) : undefined;
  return { ...(select ? { select } : {}), ...(input ? { input } : {}), ...(setStatus ? { setStatus } : {}), ...(custom ? { custom } : {}) };
}
function tuiRows(tui: unknown): number {
  const rows = object(tui) && object(tui.terminal) ? tui.terminal.rows : undefined;
  return typeof rows === "number" && Number.isFinite(rows) ? rows : 24;
}
const WORKFLOW_OVERLAY_BORDER_ROWS = 2;
const WORKFLOW_OVERLAY_TOP_MARGIN = 1;
const WORKFLOW_OVERLAY_OPTIONS = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: WORKFLOW_OVERLAY_TOP_MARGIN } } as const;
type WorkflowOverlayComponent = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
function borderWorkflowOverlay(component: WorkflowOverlayComponent, theme: { fg(color: "border", text: string): string }): WorkflowOverlayComponent {
  return { ...component, render(width: number) { const border = theme.fg("border", "─".repeat(Math.max(1, width))); return [border, ...component.render(width), border]; } };
}
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
type KeybindingGetKeys = NonNullable<KeybindingsHostCapabilities["getKeys"]>;
function isKeybindingGetKeys(value: unknown): value is KeybindingGetKeys { return typeof value === "function"; }
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined {
  if (!object(keybindings)) return undefined;
  const getKeys = keybindings.getKeys;
  return isKeybindingGetKeys(getKeys) ? getKeys.call(keybindings, name) : undefined;
}
type WorkflowKeybindings = { matches(data: string, binding: string): boolean };
const WORKFLOW_VIM_KEYS: Readonly<Record<string, string>> = { "tui.select.up": "k", "tui.select.down": "j", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" };
export function workflowKeyMatches(keybindings: WorkflowKeybindings, data: string, binding: string): boolean { return keybindings.matches(data, binding) || WORKFLOW_VIM_KEYS[binding] === data; }
const WORKFLOW_KEY_LABELS: Readonly<Record<string, string>> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
export function workflowKeyLabel(keybindings: unknown, binding: string, fallback: string, labels: Readonly<Record<string, string>> = WORKFLOW_KEY_LABELS): string {
  const keys = keybindingKeys(keybindings, binding);
  const configured = keys?.length ? keys.map((key) => labels[key] ?? key) : [fallback];
  const vim = WORKFLOW_VIM_KEYS[binding];
  return [...new Set(vim ? [...configured, vim] : configured)].join("/");
}

interface PiActionUiOptions {
  /** Told around each confirmation, as the workflow tools report a blocked run. */
  readonly reportBlocked?: ReportBlocked | undefined;
  /** Every notice, after Pi shows it. */
  readonly onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** The checkpoint in a bordered overlay with Approve, Reject and Cancel; it keeps its options and hint in view at any height. */
function reviewCheckpointOverlay(ctx: ExtensionContext, checkpoint: Parameters<ActionUi["reviewCheckpoint"]>[0]): Promise<"Approve" | "Reject" | undefined> {
  const review = formatCheckpointReview(checkpoint).split("\n").map(sanitizeDisplayText).join("\n");
  return ctx.ui.custom<"Approve" | "Reject" | undefined>((tui, theme, keybindings, done) => {
    const options = ["Approve", "Reject", "Cancel"];
    let selectedIndex = 0;
    let offset = 0;
    let renderedLines: string[] = [];
    const layout = () => {
      const rows = Math.max(1, tuiRows(tui) - WORKFLOW_OVERLAY_BORDER_ROWS);
      const compactControls = rows < 4;
      const titleRows = rows >= 5 ? 1 : 0;
      const hintRows = rows >= 8 ? 1 : 0;
      const separatorRows = rows >= 8 ? 1 : 0;
      const controlRows = compactControls ? 1 : options.length;
      const contentViewport = Math.max(0, rows - titleRows - hintRows - separatorRows - controlRows);
      return { rows, compactControls, titleRows, hintRows, separatorRows, contentViewport };
    };
    const move = (delta: number) => {
      const maxOffset = Math.max(0, renderedLines.length - layout().contentViewport);
      offset = Math.max(0, Math.min(maxOffset, offset + delta));
    };
    return borderWorkflowOverlay({
      render(width: number) {
        renderedLines = truncateToVisualLines(review, Number.MAX_SAFE_INTEGER, width, 0).visualLines;
        const currentLayout = layout();
        const maxOffset = Math.max(0, renderedLines.length - currentLayout.contentViewport);
        offset = Math.min(offset, maxOffset);
        // Pi's key hints over the keybindings Pi handed the overlay; j and k move as the arrows do.
        const keys = (binding: string, fallback: string): string => workflowKeyLabel(keybindings, binding, fallback, {});
        // select and cancel first, so a narrow overlay cuts the scroll keys rather than them.
        const hints = [rawKeyHint(keys("tui.select.confirm", "enter"), "select"), rawKeyHint(keys("tui.select.cancel", "escape"), "cancel"), rawKeyHint(["up", "down", "pageUp", "pageDown"].map((key) => keys(`tui.select.${key}`, key)).join("/"), "scroll")];
        const hint = truncateToVisualLines(hints.join(theme.fg("dim", " · ")), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
        const controls = currentLayout.compactControls
          ? [options.map((option, index) => `${index === selectedIndex ? "[" : " "}${option}${index === selectedIndex ? "]" : " "}`).join(" ")]
          : options.map((option, index) => `${index === selectedIndex ? "→ " : "  "}${option}`);
        return [
          ...(currentLayout.titleRows ? [theme.fg("accent", "Checkpoint review")] : []),
          ...renderedLines.slice(offset, offset + currentLayout.contentViewport),
          ...(currentLayout.separatorRows ? [""] : []),
          ...controls,
          ...(currentLayout.hintRows ? [hint] : []),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if (workflowKeyMatches(keybindings, data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
        else if (workflowKeyMatches(keybindings, data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
        else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) move(-layout().contentViewport);
        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) move(layout().contentViewport);
        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
          const selected = options[selectedIndex];
          done(isCheckpointDecision(selected) ? selected : undefined);
        }
        else if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) done(undefined);
        tui.requestRender();
      },
    }, theme);
  }, { overlay: true, overlayOptions: WORKFLOW_OVERLAY_OPTIONS });
}

/**
 * The ActionUi over Pi's own UI: its dialogs, the workflow-stop status and the working message. In the TUI the checkpoint
 * review is a custom component; elsewhere it is Pi's select.
 * Pi shows one custom component at a time: a dialog or custom opened while another custom is shown replaces it and afterwards
 * restores the editor rather than that component, which leaves its promise pending and the session waiting on it. So this
 * ActionUi runs while no custom is shown: runAgentsWorkspace (src/agents-command.ts) closes the workspace first.
 */
export function createPiActionUi(ctx: ExtensionContext, options: PiActionUiOptions): ActionUi {
  const notify = (message: string, level?: "info" | "warning" | "error"): void => {
    ctx.ui.notify(message, level);
    options.onNotify?.(message, level);
  };
  // Hosts outside Pi's TUI may lack a dialog: a missing select, input or setStatus is a cancel or nothing, as before the workspace.
  const capabilities = () => uiHostCapabilities(ctx.ui);
  const select = async (title: string, choices: readonly string[]): Promise<string | undefined> => capabilities()?.select?.(title, [...choices]);
  const input = async (title: string, placeholder?: string): Promise<string | undefined> => capabilities()?.input?.(title, placeholder);
  return {
    notify,
    confirm: (title, message) => confirmWithBlocked({ confirm: (dialogTitle, dialogMessage) => ctx.ui.confirm(dialogTitle, dialogMessage) }, options.reportBlocked, title, message),
    select,
    input,
    editText: async (title, prefill) => (await ctx.ui.editor(title, prefill))?.trim() || undefined,
    async reviewCheckpoint(checkpoint) {
      if (ctx.mode === "tui") return reviewCheckpointOverlay(ctx, checkpoint);
      const choice = await select(formatCheckpointReview(checkpoint), ["Approve", "Reject", "Cancel"]);
      return isCheckpointDecision(choice) ? choice : undefined;
    },
    //NOTE: no caller reaches it: the editor actions run in place, and outside the TUI they are not offered.
    async openArtifact(_artifact, label) { notify(`Cannot open ${label}: no external editor is configured.`, "warning"); },
    status(text) { capabilities()?.setStatus?.("workflow-stop", text); },
    setWorkingMessage(message) { ctx.ui.setWorkingMessage(message); },
  };
}
