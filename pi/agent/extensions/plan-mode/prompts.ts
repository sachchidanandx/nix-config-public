import { relative } from "node:path";
import { type ActivePlan, currentStepIndex, type PlanStep, PROGRESS_TOOL } from "./state.ts";

/** System-prompt section injected only while in plan mode (key: `plan_mode`). */
export const PLAN_MODE_SECTION = `You are in PLAN MODE. The user wants a plan they can review before anything changes.

- Do not modify anything: no file edits, no git state changes, no installs, no commands with side effects. The edit and write tools are unavailable.
- bash runs in a sandbox: the project and home folder are read-only (writes fail with "Operation not permitted" or "Read-only file system"), but /tmp and $TMPDIR are writable for scratch files, test data and downloads, and network reads work. Commands with external side effects (pushes, API writes, deploys, services, killing processes) need the user's approval. Commands that update .git (git fetch/pull) fail; use git ls-remote or gh instead.
- Investigate first: read the relevant code and configuration (read, grep, find, ls, read-only bash) until you understand the current state and the change needed.
- Slack, Atlassian (Jira/Confluence) and Chrome DevTools read tools are pre-approved for investigation: reach them from codemode scripts (find them with searchTools() or describeNamespace("mcp__slack" | "mcp__atlassian" | "mcp__chrome_devtools")). Their write tools (posting messages, creating/editing issues or pages, browser click/type/evaluate_script) ask the user first.
- If requirements are ambiguous or a decision is the user's to make, ask instead of guessing: use the ask_user tool for concise multiple-choice questions and continue with the answers (if ask_user is unavailable, ask in plain text and end your turn).
- Write the plan for an implementer who has not seen your investigation: after approval, a different and often less capable model may implement it with only the plan as context. It should be able to follow the plan step by step without re-investigating or making design decisions. Include:
  - the exact files to change, and the functions, types, settings or keys involved; say what must not change;
  - real code: complete snippets for new code, and before/after snippets (or the exact text to find and its replacement) for edits; describe in words only what is truly trivial;
  - existing code to copy patterns from (file and function), and the naming, error-handling and test conventions to follow;
  - the decisions you made and the alternatives you rejected, so the implementer does not redesign; edge cases to handle;
  - the exact commands to build, test and verify, with the expected results.
  Keep it proportional: a one-line fix needs a short plan, not an essay.
- If the user shared images (screenshots, mockups, diagrams, error dialogs), assume the implementer cannot see them: it may be a text-only model or run in a fresh session. Put everything the implementation needs from each image into the plan as text: exact visible text and labels, layout and spacing, colors and sizes, values from tables or charts, error messages, code shown. If an image file itself has to go into the project (an asset, a screenshot for docs), give its absolute source path (shared images come with a file path in the user's message; pasted ones are saved in $TMPDIR as pi-clipboard-*.png) and the destination, so the implementer can copy it with a tool call without viewing it.
- When the plan is ready, call exit_plan_mode with a short title, the full plan in markdown (the detail above, why, and risks), and the ordered implementation steps. Each step should be one concrete, checkable action that names the files it touches.
- Do not start implementing. The user approves, requests changes, or keeps planning. If they request changes, revise the plan and call exit_plan_mode again.
- Pure questions that need no changes can simply be answered; exit_plan_mode is only for proposing changes.`;

const STATUS_LABELS: Record<PlanStep["status"], string> = {
  pending: "pending",
  in_progress: "in progress",
  done: "done",
  skipped: "skipped",
};

export function formatSteps(plan: ActivePlan): string {
  return plan.steps
    .map((step, i) => `${i + 1}. [${STATUS_LABELS[step.status]}] ${step.text}${step.note ? ` (note: ${step.note})` : ""}`)
    .join("\n");
}

/**
 * System-prompt section while executing an approved plan (key: `active_plan`).
 * Rebuilt for every user prompt, so it survives compaction; within a run the
 * plan_update results carry the newer statuses.
 */
export function activePlanSection(plan: ActivePlan, cwd: string): string {
  const file = plan.file ? `\nPlan file: ${relative(cwd, plan.file)}` : "";
  return `You are executing an approved plan: "${plan.title}".${file}

Follow the plan as written. It was made after investigating the code, so use its file paths, names, code snippets and patterns as given; do not redesign it or add scope. Read the code around each change before editing so the snippets fit. Do not rely on images from the conversation: the plan describes what they show, and when an image file has to go into the project, copy it from the path the plan gives with a tool call. If the plan turns out to be wrong or incomplete (a snippet does not match the code, a file or function is missing, a command fails in a way the plan did not expect), make the smallest fix that keeps the plan's intent and record it in that step's ${PROGRESS_TOOL} note. If the fix would change the design, stop and ask the user.

Track progress with the ${PROGRESS_TOOL} tool: mark a step "in_progress" when you start it and "done" when it is finished, or "skipped" with a note saying why. Work through the steps in order unless the user says otherwise. The statuses below are as of the user's latest message; ${PROGRESS_TOOL} results are more recent.

Steps:
${formatSteps(plan)}

Plan:
${plan.plan.trim()}`;
}

/** First message of the execution run; the full plan is in the active_plan section. */
export function executionPrompt(plan: ActivePlan): string {
  const next = plan.steps[currentStepIndex(plan)];
  const start = next ? `\n\nStart with step ${plan.steps.indexOf(next) + 1}: ${next.text}` : "";
  return `The user approved the plan "${plan.title}". Plan mode is off and you have full tool access. The plan and each step's status are in <active_plan> in your system prompt.

Implement it step by step, following the plan's file paths, code snippets and patterns, and verify your work. Call ${PROGRESS_TOOL} with status "in_progress" when you start a step and "done" (or "skipped", with a note) when you finish it.${start}`;
}
