/**
 * exit_plan_mode: the model submits a finished plan; the user approves it
 * (here or in a fresh session), sends feedback, or keeps planning.
 *
 * Approval ends the run (terminate) instead of continuing it: prompt sections
 * are fixed per run, so continuing would give the model write tools while its
 * system prompt still says "plan mode". The extension starts a fresh run for
 * execution once this one has settled.
 *
 * plan_update: the model reports progress on the active plan's steps.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type ActivePlan,
  currentStepIndex,
  type Mode,
  PLAN_TOOL,
  planProgress,
  PROGRESS_TOOL,
  type ProposedPlan,
  type StepStatus,
} from "./state.ts";

// ---------------------------------------------------------------------------
// exit_plan_mode
// ---------------------------------------------------------------------------

type Decision = "approved" | "approved-fresh" | "feedback" | "cancelled" | "no-ui" | "not-planning";

export interface ExitPlanDetails {
  decision: Decision;
  title: string;
  steps: string[];
  feedback?: string;
}

const APPROVE = "Approve & execute";
const APPROVE_FRESH = "Approve, clear context & execute";
const FEEDBACK = "Keep planning — send feedback";
const CANCEL = "Cancel — stay in plan mode";

export interface ExitPlanModeDeps {
  getMode(): Mode;
  /** Remember the submitted plan so `/plan show|edit|execute` can use it later. */
  recordProposal(plan: ProposedPlan): void;
  /** Switch to execute mode (and its default model) and schedule execution (in this session or a fresh one). */
  approve(plan: ProposedPlan, ctx: ExtensionContext, options: { fresh: boolean }): void | Promise<void>;
}

const textResult = <T>(text: string, details: T, terminate = false) => ({
  content: [{ type: "text" as const, text }],
  details,
  terminate,
});

export function createExitPlanModeTool(deps: ExitPlanModeDeps) {
  return defineTool({
    name: PLAN_TOOL,
    label: "Exit Plan Mode",
    description:
      "Plan mode only. Submit the finished implementation plan for the user's approval. " +
      "The user either approves it (plan mode ends and implementation starts in a new turn), " +
      "requests changes (revise and call this again), or keeps planning.",
    promptSnippet: "Submit the finished plan for the user's approval (plan mode only)",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the plan (at most ~8 words)" }),
      plan: Type.String({
        description:
          "The full plan in markdown, self-contained for an implementer who has not seen your investigation (or any images): " +
          "exact files and symbols, code snippets or before/after edits, patterns to follow, decisions, risks, and verification commands",
      }),
      steps: Type.Array(Type.String(), {
        minItems: 1,
        description: "Ordered implementation steps; each one concrete, checkable, and naming the files it touches",
      }),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const title = params.title.trim() || "Plan";
      const steps = params.steps.map((step) => step.trim()).filter(Boolean);
      const proposal: ProposedPlan = { title, plan: params.plan, steps };
      const base = { title, steps };

      if (deps.getMode() !== "plan") {
        return textResult("Plan mode is already off; continue with the task.", {
          ...base,
          decision: "not-planning",
        } satisfies ExitPlanDetails);
      }
      deps.recordProposal(proposal);
      if (!ctx.hasUI) {
        return textResult(
          "No interactive user is available to approve the plan, so nothing will be executed. Stop here.",
          { ...base, decision: "no-ui" } satisfies ExitPlanDetails,
          true,
        );
      }

      const choice = await ctx.ui.select(`Plan: ${title}`, [APPROVE, APPROVE_FRESH, FEEDBACK, CANCEL], { signal });

      if (choice === APPROVE || choice === APPROVE_FRESH) {
        const fresh = choice === APPROVE_FRESH;
        await deps.approve(proposal, ctx, { fresh });
        return textResult(
          fresh
            ? "The user approved the plan and will execute it in a fresh session. Stop here; do not do anything else."
            : "The user approved the plan. Plan mode is now off. Do not do anything else in this turn: " +
                "implementation starts automatically in the next turn.",
          { ...base, decision: fresh ? "approved-fresh" : "approved" } satisfies ExitPlanDetails,
          true,
        );
      }

      if (choice === FEEDBACK) {
        const feedback = (await ctx.ui.editor("What should change in the plan?", ""))?.trim();
        if (feedback) {
          return textResult(
            `The user wants changes before approving:\n\n${feedback}\n\n` +
              "Revise the plan (investigate further if needed) and call exit_plan_mode again.",
            { ...base, decision: "feedback", feedback } satisfies ExitPlanDetails,
          );
        }
      }

      return textResult(
        "The user did not approve the plan and is staying in plan mode. Stop here and wait for their next message.",
        { ...base, decision: "cancelled" } satisfies ExitPlanDetails,
        true,
      );
    },

    renderCall(args, theme) {
      const container = new Container();
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Plan";
      container.addChild(new Text(theme.fg("toolTitle", theme.bold(`📋 ${title}`)), 0, 0));
      if (typeof args.plan === "string" && args.plan.trim()) {
        container.addChild(new Markdown(args.plan, 0, 1, getMarkdownTheme()));
      }
      if (Array.isArray(args.steps) && args.steps.length > 0) {
        const lines = args.steps.map((step, i) => `${theme.fg("muted", `${i + 1}.`)} ${step}`);
        container.addChild(new Text(`${theme.fg("accent", "Steps")}\n${lines.join("\n")}`, 0, 0));
      }
      return container;
    },

    renderResult(toolResult, _options, theme) {
      const details = toolResult.details as ExitPlanDetails | undefined;
      switch (details?.decision) {
        case "approved":
          return new Text(theme.fg("success", "✓ Approved — executing"), 0, 0);
        case "approved-fresh":
          return new Text(theme.fg("success", "✓ Approved — executing in a fresh session"), 0, 0);
        case "feedback":
          return new Text(`${theme.fg("warning", "✎ Changes requested: ")}${theme.fg("muted", details.feedback ?? "")}`, 0, 0);
        case "cancelled":
          return new Text(theme.fg("muted", "✗ Not approved — still planning"), 0, 0);
        case "no-ui":
          return new Text(theme.fg("warning", "Plan recorded (no interactive approval available)"), 0, 0);
        default: {
          const text = toolResult.content[0];
          return new Text(text?.type === "text" ? theme.fg("muted", text.text) : "", 0, 0);
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// plan_update
// ---------------------------------------------------------------------------

export interface PlanUpdateDetails {
  step: number;
  status: StepStatus;
  text?: string;
  finished?: number;
  total?: number;
  complete?: boolean;
  error?: string;
}

export interface PlanUpdateDeps {
  /**
   * Apply the update to the active plan. Returns the updated plan and whether
   * it is now complete; throws when there is no active plan or the step is invalid.
   */
  update(step: number, status: StepStatus, note: string | undefined, ctx: ExtensionContext): { plan: ActivePlan; complete: boolean };
}

const STATUS_ICONS: Record<StepStatus, string> = { pending: "☐", in_progress: "▸", done: "☑", skipped: "⊘" };

export function createPlanUpdateTool(deps: PlanUpdateDeps) {
  return defineTool({
    name: PROGRESS_TOOL,
    label: "Plan Progress",
    description:
      "Report progress on the approved plan being executed. Mark a step in_progress when you start it, " +
      "and done (or skipped, with a note saying why) when you finish it. Steps are numbered from 1.",
    promptSnippet: "Report progress on the approved plan's steps (in_progress / done / skipped)",
    parameters: Type.Object({
      step: Type.Integer({ minimum: 1, description: "Step number, starting at 1" }),
      status: Type.Union([Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("skipped")], {
        description: "New status of the step",
      }),
      note: Type.Optional(Type.String({ description: "Optional short note, e.g. why a step was skipped" })),
    }),
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { plan, complete } = deps.update(params.step, params.status, params.note, ctx);
      const { finished, total } = planProgress(plan);
      const details: PlanUpdateDetails = {
        step: params.step,
        status: params.status,
        text: plan.steps[params.step - 1]?.text,
        finished,
        total,
        complete,
      };
      if (complete) {
        return textResult(`Step ${params.step} marked ${params.status}. All ${total} steps are finished; the plan is complete.`, details);
      }
      const nextIndex = currentStepIndex(plan);
      const upcoming = plan.steps
        .map((step, i) => ({ step, i }))
        .filter(({ step, i }) => i >= nextIndex && (step.status === "pending" || step.status === "in_progress"))
        .slice(0, 3)
        .map(({ step, i }) => `${i + 1}. [${step.status === "in_progress" ? "in progress" : "pending"}] ${step.text}`);
      return textResult(
        `Step ${params.step} marked ${params.status}. Progress: ${finished}/${total}.` +
          (upcoming.length ? `\nNext:\n${upcoming.join("\n")}` : ""),
        details,
      );
    },

    renderCall(args, theme) {
      const status = typeof args.status === "string" ? args.status : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("plan_update ")) + theme.fg("muted", `step ${args.step ?? "?"} → ${status.replace("_", " ")}`),
        0,
        0,
      );
    },

    renderResult(toolResult, _options, theme) {
      const details = toolResult.details as PlanUpdateDetails | undefined;
      if (!details || details.total === undefined) {
        const text = toolResult.content[0];
        return new Text(text?.type === "text" ? theme.fg("error", text.text) : "", 0, 0);
      }
      const icon = STATUS_ICONS[details.status];
      const color = details.status === "done" ? "success" : details.status === "skipped" ? "dim" : "accent";
      const suffix = details.complete ? theme.fg("success", "  ✓ plan complete") : theme.fg("dim", `  ${details.finished}/${details.total}`);
      return new Text(`${theme.fg(color, `${icon} ${details.step}. ${details.text ?? ""}`)}${suffix}`, 0, 0);
    },
  });
}
