/**
 * Plan-mode state: mode, active/proposed plans, tool sets per mode, and
 * persistence.
 *
 * The whole state is appended as one custom session entry on every change
 * and restored from the *current branch* (not all entries), so forks, /tree
 * navigation, resume and reload all see the state at that point in history.
 * Custom entries are never sent to the model.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Mode = "plan" | "execute";
export type StepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface PlanStep {
  text: string;
  status: StepStatus;
  note?: string;
}

/** A plan as submitted through exit_plan_mode. */
export interface ProposedPlan {
  title: string;
  plan: string;
  steps: string[];
}

/** An approved plan being executed, with per-step progress. */
export interface ActivePlan {
  title: string;
  plan: string;
  steps: PlanStep[];
  /** Absolute path of the plan file under <cwd>/.pi/plans/, when written. */
  file?: string;
  approvedAt: number;
}

export interface PlanState {
  mode: Mode;
  activePlan?: ActivePlan;
  lastProposed?: ProposedPlan;
  /** Set when a new session was created to execute activePlan (fresh-context execute). */
  kickoff?: boolean;
}

export interface PersistedState extends PlanState {
  version: 2;
}

export const STATE_ENTRY_TYPE = "plan-mode-state";

export const PLAN_TOOL = "exit_plan_mode";
export const PROGRESS_TOOL = "plan_update";
/** Tools this extension switches on and off itself. */
export const MANAGED_TOOLS = new Set([PLAN_TOOL, PROGRESS_TOOL]);

/** Built-in tools that can change files; hidden and blocked in plan mode. */
export const WRITE_TOOLS = new Set(["edit", "write", "powershell"]);

/** Read-only built-ins switched on while planning. */
export const PLAN_EXTRA_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Read-only tools of the configured MCP servers, allowed in plan mode
 * without asking (mcp__<server>__<tool>; `-` in server names becomes `_`).
 * Only reads, searches and browser navigation/observation are listed;
 * everything else — Slack posts, Jira/Confluence writes,
 * executeWrite/executeDestructive, page interaction (click/fill/type/
 * evaluate_script), and file-writing or tab-closing browser tools — falls
 * through to the per-call ask. A renamed or removed server tool simply
 * stops matching and asks again. Tool names from describeNamespace(),
 * 2026-10-06.
 */
export const READ_ONLY_MCP_TOOLS = new Set([
  // slack: searches, reads, lists (slack_send_message, drafts, reactions-add, list/canvas writes, uploads ask)
  "mcp__slack__slack_search_public",
  "mcp__slack__slack_search_public_and_private",
  "mcp__slack__slack_search_channels",
  "mcp__slack__slack_search_users",
  "mcp__slack__slack_search_emojis",
  "mcp__slack__slack_read_channel",
  "mcp__slack__slack_read_thread",
  "mcp__slack__slack_read_canvas",
  "mcp__slack__slack_read_user_profile",
  "mcp__slack__slack_read_file",
  "mcp__slack__slack_read_list",
  "mcp__slack__slack_list_channel_members",
  "mcp__slack__slack_list_user_channels",
  "mcp__slack__slack_get_reactions",
  // atlassian: getters, JQL/CQL/Rovo search, graph reads, discover and the read-only execute tier
  // (createJiraIssue, editJiraIssue, transitionJiraIssue, addOrEditJiraIssueComment,
  //  create/updateConfluenceContent, addGraphContext, executeWrite, executeDestructive ask)
  "mcp__atlassian__getAccessibleAtlassianResources",
  "mcp__atlassian__atlassianUserInfo",
  "mcp__atlassian__search",
  "mcp__atlassian__searchConfluence",
  "mcp__atlassian__getConfluenceContent",
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__getLoomVideo",
  "mcp__atlassian__getGraphContext",
  "mcp__atlassian__getGraphObject",
  "mcp__atlassian__discover",
  "mcp__atlassian__executeRead",
  // chrome-devtools: navigation and observation
  // (click, drag, fill, fill_form, type_text, press_key, handle_dialog, upload_file,
  //  evaluate_script, close_page and take_heapsnapshot (requires an output path) ask)
  "mcp__chrome_devtools__new_page",
  "mcp__chrome_devtools__navigate_page",
  "mcp__chrome_devtools__list_pages",
  "mcp__chrome_devtools__select_page",
  "mcp__chrome_devtools__wait_for",
  "mcp__chrome_devtools__take_snapshot",
  "mcp__chrome_devtools__take_screenshot",
  "mcp__chrome_devtools__list_console_messages",
  "mcp__chrome_devtools__get_console_message",
  "mcp__chrome_devtools__list_network_requests",
  "mcp__chrome_devtools__get_network_request",
  "mcp__chrome_devtools__hover",
  "mcp__chrome_devtools__emulate",
  "mcp__chrome_devtools__resize_page",
  "mcp__chrome_devtools__lighthouse_audit",
  "mcp__chrome_devtools__performance_start_trace",
  "mcp__chrome_devtools__performance_stop_trace",
  "mcp__chrome_devtools__performance_analyze_insight",
]);

/**
 * Tools allowed in plan mode without asking. bash is not here: every bash
 * call goes through the bash policy. Other custom tools ask the user.
 */
export const READ_ONLY_TOOLS = new Set([
  ...PLAN_EXTRA_TOOLS,
  PLAN_TOOL,
  // ask-user extension: asks the user questions, changes nothing
  "ask_user",
  // pi.nvim nvim-bridge
  "get_latest_selection",
  "get_nvim_state",
  "get_diagnostics",
  "open_in_nvim",
  // codemode's QuickJS VM has no capabilities of its own; inner calls
  // re-enter the tool_call gate (bash gets the policy + sandbox, edit/write
  // are not callable while filtered from the active tools, MCP writes ask).
  "codemode",
  // MCP resource reads (pi built-ins, marked read-only)
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  ...READ_ONLY_MCP_TOOLS,
]);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const isMode = (value: unknown): value is Mode => value === "plan" || value === "execute";

/** Latest persisted state on the branch; version-1 entries only carried the mode. */
export function readPersistedState(branch: readonly SessionEntry[]): PlanState | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<PersistedState> | undefined;
    if (!isMode(data?.mode)) continue;
    if (data.version !== 2) return { mode: data.mode };
    return {
      mode: data.mode,
      activePlan: data.activePlan,
      lastProposed: data.lastProposed,
      kickoff: data.kickoff === true ? true : undefined,
    };
  }
  return undefined;
}

export function toPersisted(state: PlanState): PersistedState {
  return { version: 2, ...state };
}

// ---------------------------------------------------------------------------
// Tool sets
// ---------------------------------------------------------------------------

const withoutManaged = (tools: readonly string[]) => tools.filter((name) => !MANAGED_TOOLS.has(name));

/** Active tools while planning: the pre-plan set minus write tools, plus read-only tools. */
export function planModeTools(toolsBeforePlan: readonly string[]): string[] {
  return [
    ...new Set([...withoutManaged(toolsBeforePlan).filter((name) => !WRITE_TOOLS.has(name)), ...PLAN_EXTRA_TOOLS, PLAN_TOOL]),
  ];
}

/** Active tools while executing: the normal set, plus plan_update while a plan is active. */
export function executeModeTools(baseTools: readonly string[], hasActivePlan: boolean): string[] {
  const tools = withoutManaged(baseTools);
  return hasActivePlan ? [...tools, PROGRESS_TOOL] : tools;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const isFinished = (step: PlanStep) => step.status === "done" || step.status === "skipped";

/**
 * Turn a proposed plan into an active one. When it revises a plan that was
 * already running, steps with identical text keep their done/skipped status.
 * Each approval gets its own plan file (`file` starts unset).
 */
export function activatePlan(proposed: ProposedPlan, previous?: ActivePlan, now = Date.now()): ActivePlan {
  const finished = new Map(
    (previous?.steps ?? []).filter(isFinished).map((step) => [step.text.trim(), step] as const),
  );
  return {
    title: proposed.title,
    plan: proposed.plan,
    steps: proposed.steps.map((text) => {
      const kept = finished.get(text.trim());
      return kept ? { ...kept, text } : { text, status: "pending" as const };
    }),
    approvedAt: now,
  };
}

export function planProgress(plan: ActivePlan): { finished: number; total: number } {
  return { finished: plan.steps.filter(isFinished).length, total: plan.steps.length };
}

export function isPlanComplete(plan: ActivePlan): boolean {
  return plan.steps.length > 0 && plan.steps.every(isFinished);
}

/** Index of the step being worked on: the first in-progress one, else the first pending one; -1 when all are finished. */
export function currentStepIndex(plan: ActivePlan): number {
  const inProgress = plan.steps.findIndex((step) => step.status === "in_progress");
  return inProgress >= 0 ? inProgress : plan.steps.findIndex((step) => step.status === "pending");
}

/** Returns an updated copy; `step` is 1-based. Throws for an unknown step. */
export function updatePlanStep(plan: ActivePlan, step: number, status: StepStatus, note?: string): ActivePlan {
  if (!Number.isInteger(step) || step < 1 || step > plan.steps.length) {
    throw new Error(`Step ${step} does not exist; the plan has steps 1-${plan.steps.length}.`);
  }
  const trimmedNote = note?.trim();
  return {
    ...plan,
    steps: plan.steps.map((current, index) =>
      index === step - 1 ? { ...current, status, note: trimmedNote || current.note } : current,
    ),
  };
}
