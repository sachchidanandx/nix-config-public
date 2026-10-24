/**
 * Plan mode: a read-only mode where the agent investigates and proposes a
 * plan, and only changes things after the user approves it. Approved plans
 * are executed with step-by-step progress tracking.
 *
 *   ctrl+shift+tab / /plan       cycle plan <-> execute
 *   /plan on | off               set the mode
 *   /plan show | status          show the plan / its progress (not sent to the model)
 *   /plan edit                   edit the plan (title, steps, body) in the editor
 *   /plan execute [--fresh]      execute the last proposed plan (--fresh: in a new session)
 *   /plan clear                  stop tracking the active plan
 *   /plan <prompt>               switch to plan mode and send <prompt>
 *   --plan / --no-plan           start mode for sessions without saved state
 *
 * New interactive (TUI/RPC) sessions start in plan mode; resumed, reloaded
 * and forked sessions restore the state saved on their branch. Print/JSON
 * runs start in execute mode unless --plan is given.
 *
 * Read-only enforcement in plan mode (details: SANDBOX.md):
 *   1. edit/write are removed from the active tools (read/grep/find/ls added)
 *   2. tool_call blocks write tools, allows known read-only tools (READ_ONLY_TOOLS:
 *      built-ins, codemode, MCP resource reads and the slack/atlassian/
 *      chrome-devtools read tools) and asks before anything else
 *   3. bash commands go through the side-effect policy (bash-policy.ts):
 *      pushes, API writes, deploys, services, ... ask; everything else runs
 *   4. every plan-mode bash command runs in the OS sandbox (sandbox.ts;
 *      Seatbelt on macOS, bubblewrap on Linux):
 *      read-only filesystem except /tmp, $TMPDIR and cache folders. There is
 *      no bypass: approved commands are sandboxed too, and without a working
 *      sandbox bash is refused while planning. `!cmd` from the user is not
 *      sandboxed.
 *
 * Default model per mode (optional): settings.json `planMode.plan` and
 * `planMode.execute` are `{ "model": "provider/modelId", "thinking": "high" }`
 * (thinking optional). Every mode switch, plan approval and new session
 * switches to that mode's default; ctrl+p still cycles pi's scoped models
 * (enabledModels) until the next switch. Resumed, reloaded and forked
 * sessions keep their model, and --model / --provider wins at startup. A
 * mode without a default leaves the model alone. Helpers: models.ts.
 *
 * Execution: an approved plan becomes the active plan. The model reports
 * progress with plan_update; progress shows in a widget above the editor, in
 * the footer badge (status key "plan-mode", placed by the footer extension)
 * and in <cwd>/.pi/plans/<date>-<slug>.md.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  getAgentDir,
  getMarkdownTheme,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { classifyBashCommand } from "./bash-policy.ts";
import { isFreshSession, modelFlagGiven, readModeDefaults } from "./models.ts";
import { parsePlanFile, renderPlanFile, writePlanFile } from "./plan-file.ts";
import {
  isProfileError,
  isSandboxDenial,
  type SandboxBackend,
  sandboxBackend,
  sandboxParams,
  wrapCommand,
} from "./sandbox.ts";
import { activePlanSection, executionPrompt, PLAN_MODE_SECTION } from "./prompts.ts";
import {
  type ActivePlan,
  activatePlan,
  currentStepIndex,
  executeModeTools,
  isPlanComplete,
  MANAGED_TOOLS,
  type Mode,
  type PlanStep,
  planModeTools,
  planProgress,
  type ProposedPlan,
  READ_ONLY_TOOLS,
  readPersistedState,
  STATE_ENTRY_TYPE,
  toPersisted,
  updatePlanStep,
  WRITE_TOOLS,
} from "./state.ts";
import { createExitPlanModeTool, createPlanUpdateTool } from "./tools.ts";

const STATUS_KEY = "plan-mode";
const WIDGET_KEY = "plan-mode-progress";
const PLAN_SECTION_KEY = "plan_mode";
const ACTIVE_PLAN_SECTION_KEY = "active_plan";
const EXECUTE_MESSAGE_TYPE = "plan-mode-execute";
/** Transcript cards (show / status / complete); custom entries, never sent to the model. */
const CARD_ENTRY_TYPE = "plan-mode-card";
/** ctrl+shift+tab as libvterm sends it when the kitty keyboard protocol is off. */
const LEGACY_CTRL_SHIFT_TAB = "\x1b[1;6Z";
/** Steps shown in the progress widget before it switches to a window around the current step. */
const WIDGET_MAX_STEPS = 8;

const SANDBOX_WRITABLE =
  process.platform === "darwin"
    ? "/tmp, $TMPDIR and cache folders (~/.cache, ~/Library/Caches, ~/.npm)"
    : "/tmp, $TMPDIR and cache folders (~/.cache, ~/.npm)";
const SANDBOX_NOTE = `[plan mode] Blocked by the plan-mode sandbox: the filesystem is read-only except ${SANDBOX_WRITABLE}. Use /tmp for scratch files, or put this step in the plan.`;

/** Claude Code's mode colors: teal for plan, violet for accept-edits/execute. */
const BADGE_COLORS: Record<Mode, { dark: [number, number, number]; light: [number, number, number] }> = {
  plan: { dark: [72, 150, 140], light: [0, 102, 102] },
  execute: { dark: [175, 135, 255], light: [135, 0, 255] },
};

interface PlanCard {
  kind: "show" | "status" | "complete";
  title: string;
  plan?: string;
  steps: PlanStep[];
  file?: string;
}

const SUBCOMMANDS = [
  { value: "on", description: "Switch to plan mode (read-only)" },
  { value: "off", description: "Switch to execute mode (full access)" },
  { value: "show", description: "Show the active or last proposed plan" },
  { value: "status", description: "Show progress of the active plan" },
  { value: "edit", description: "Edit the active or last proposed plan" },
  { value: "execute", description: "Execute the last proposed plan in this session" },
  { value: "execute --fresh", description: "Execute the plan in a new session (clean context)" },
  { value: "clear", description: "Stop tracking the active plan" },
];

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderStepLine(step: PlanStep, index: number, theme: Theme): string {
  const n = `${index + 1}.`;
  switch (step.status) {
    case "done":
      return `${theme.fg("success", "☑")} ${theme.fg("muted", `${n} ${step.text}`)}`;
    case "skipped":
      return theme.fg("dim", `⊘ ${n} ${step.text}${step.note ? ` — ${step.note}` : ""}`);
    case "in_progress":
      return theme.fg("accent", theme.bold(`▸ ${n} ${step.text}`));
    default:
      return `${theme.fg("muted", "☐")} ${n} ${step.text}`;
  }
}

function progressWidgetLines(plan: ActivePlan, paused: boolean, theme: Theme): string[] {
  const { finished, total } = planProgress(plan);
  const lines = [
    theme.fg("accent", theme.bold(`📋 ${plan.title}`)) +
      theme.fg("dim", `  ${finished}/${total}`) +
      (paused ? theme.fg("warning", "  · paused (plan mode)") : ""),
  ];
  let start = 0;
  let end = total;
  if (total > WIDGET_MAX_STEPS) {
    const current = Math.max(currentStepIndex(plan), 0);
    start = Math.min(Math.max(current - 2, 0), total - WIDGET_MAX_STEPS);
    end = start + WIDGET_MAX_STEPS;
  }
  if (start > 0) lines.push(theme.fg("dim", `  … ${start} earlier`));
  for (let i = start; i < end; i++) lines.push(`  ${renderStepLine(plan.steps[i], i, theme)}`);
  if (end < total) lines.push(theme.fg("dim", `  … ${total - end} more`));
  return lines;
}

export default function planMode(pi: ExtensionAPI): void {
  let mode: Mode = "execute";
  let activePlan: ActivePlan | undefined;
  let lastProposed: ProposedPlan | undefined;
  /** Active tools just before entering plan mode, restored on exit. */
  let toolsBeforePlan: string[] | undefined;
  /** Ask-keys approved with "allow for this session" (bash keys and `tool:<name>`). */
  let sessionApprovals = new Set<string>();
  /** Approval waiting for the current run to settle before execution starts. */
  let pendingExecution: { fresh: boolean } | undefined;
  /** Attach the execution message to the next prompt. */
  let attachKickoff = false;
  /** The kickoff came from persisted state (fresh session); clear it once used. */
  let kickoffPersisted = false;
  let stopLegacyKeyListener: (() => void) | undefined;
  /** OS sandbox backend (Seatbelt on macOS, bubblewrap on Linux), if usable. */
  const backend: SandboxBackend | undefined = sandboxBackend();
  /** The OS sandbox failed to start (bad profile / bwrap setup error); bash is refused in plan mode for the session. */
  let sandboxBroken = false;
  let sandboxNoticeShown = false;
  /** planMode settings problems already reported (warn once per session). */
  let reportedProblems = new Set<string>();

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only until a plan is approved)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-plan", {
    description: "Start in execute mode instead of plan mode",
    type: "boolean",
    default: false,
  });

  // -------------------------------------------------------------------------
  // State, tools and UI
  // -------------------------------------------------------------------------

  function persist(): void {
    pi.appendEntry(STATE_ENTRY_TYPE, toPersisted({ mode, activePlan, lastProposed }));
  }

  function applyTools(): void {
    const active = pi.getActiveTools();
    if (mode === "plan") {
      toolsBeforePlan ??= active.filter((name) => !MANAGED_TOOLS.has(name));
      pi.setActiveTools(planModeTools(toolsBeforePlan));
    } else {
      const base = toolsBeforePlan ?? active;
      toolsBeforePlan = undefined;
      pi.setActiveTools(executeModeTools(base, activePlan !== undefined));
    }
  }

  function renderBadge(ctx: ExtensionContext): string {
    const variant = ctx.ui.theme.name?.includes("light") ? "light" : "dark";
    const [r, g, b] = BADGE_COLORS[mode][variant];
    let label = mode === "plan" ? "⏸ plan" : "⏵⏵ execute";
    if (mode === "execute" && activePlan) {
      const { finished, total } = planProgress(activePlan);
      label += ` ${finished}/${total}`;
    }
    return `\x1b[38;2;${r};${g};${b}m${label}\x1b[39m`;
  }

  function updateUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, renderBadge(ctx));
    if (ctx.mode !== "tui") return;
    const plan = activePlan;
    const paused = mode === "plan";
    ctx.ui.setWidget(
      WIDGET_KEY,
      plan
        ? (_tui, theme) => ({
            render: (width: number) => progressWidgetLines(plan, paused, theme).map((line) => truncateToWidth(line, width)),
            invalidate() {},
          })
        : undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Default model per mode (planMode.plan / planMode.execute in settings.json)
  // -------------------------------------------------------------------------

  function warnOnce(ctx: ExtensionContext, message: string): void {
    if (reportedProblems.has(message)) return;
    reportedProblems.add(message);
    if (ctx.hasUI) ctx.ui.notify(`Plan mode: ${message}`, "warning");
  }

  /**
   * Switch to the current mode's default model and thinking level, when one is
   * configured. Runs on every mode switch, so a ctrl+p pick lasts until the
   * next switch; without a default for the mode the model is left alone.
   */
  async function applyModeDefault(ctx: ExtensionContext): Promise<void> {
    const { defaults, problems } = readModeDefaults(pi.getSettings());
    for (const problem of problems) warnOnce(ctx, problem);
    const target = defaults[mode];
    if (!target) return;
    const ref = `${target.provider}/${target.id}`;
    const model = ctx.modelRegistry.find(target.provider, target.id);
    if (!model) return warnOnce(ctx, `planMode.${mode}.model "${ref}" is not a known model`);
    try {
      const current = ctx.model;
      if (current?.provider !== model.provider || current?.id !== model.id) {
        if (!(await pi.setModel(model))) return warnOnce(ctx, `no credentials for ${ref}; run /login`);
      }
      if (target.thinking) pi.setThinkingLevel(target.thinking);
    } catch (error) {
      warnOnce(ctx, `could not switch to ${ref}: ${String(error)}`);
    }
  }

  async function switchMode(next: Mode, ctx: ExtensionContext, options: { quiet?: boolean } = {}): Promise<void> {
    if (next === mode) return;
    mode = next;
    applyTools();
    persist();
    updateUI(ctx);
    if (next === "plan" && !sandboxReady()) noticeSandboxUnavailable(ctx);
    if (!options.quiet && !ctx.isIdle()) {
      ctx.ui.notify(
        next === "plan"
          ? "Plan mode on: read-only from the next model request"
          : "Plan mode off: full access from the next model request",
        "info",
      );
    }
    await applyModeDefault(ctx);
  }

  const cycleMode = (ctx: ExtensionContext) => switchMode(mode === "plan" ? "execute" : "plan", ctx);

  /** Write the active plan's file; failures are reported but never block progress. */
  function savePlanFile(ctx: ExtensionContext): void {
    if (!activePlan) return;
    try {
      activePlan = { ...activePlan, file: writePlanFile(ctx.cwd, activePlan) };
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not write the plan file: ${String(error)}`, "warning");
    }
  }

  /** Save file and state after the active plan changed; finishes it when complete. */
  function commitActivePlan(ctx: ExtensionContext): void {
    savePlanFile(ctx);
    if (activePlan && isPlanComplete(activePlan)) {
      pi.appendEntry<PlanCard>(CARD_ENTRY_TYPE, {
        kind: "complete",
        title: activePlan.title,
        steps: activePlan.steps,
        file: activePlan.file,
      });
      activePlan = undefined;
    }
    applyTools();
    persist();
    updateUI(ctx);
  }

  /** Make `proposal` the active plan and switch to execute mode. */
  async function approve(proposal: ProposedPlan, ctx: ExtensionContext): Promise<void> {
    lastProposed = proposal;
    activePlan = activatePlan(proposal, activePlan);
    savePlanFile(ctx);
    mode = "execute";
    applyTools();
    persist();
    updateUI(ctx);
    await applyModeDefault(ctx);
  }

  function startExecution(): void {
    if (!activePlan) return;
    attachKickoff = true;
    pi.sendUserMessage(`Implement the approved plan: ${activePlan.title}`);
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  pi.registerTool(
    createExitPlanModeTool({
      getMode: () => mode,
      recordProposal(plan) {
        lastProposed = plan;
        persist();
      },
      async approve(plan, ctx, { fresh }) {
        await approve(plan, ctx);
        pendingExecution = { fresh };
      },
    }),
  );

  pi.registerTool(
    createPlanUpdateTool({
      update(step, status, note, ctx) {
        if (!activePlan || mode !== "execute") throw new Error("There is no approved plan being executed.");
        activePlan = updatePlanStep(activePlan, step, status, note);
        const snapshot = activePlan;
        const complete = isPlanComplete(snapshot);
        commitActivePlan(ctx);
        return { plan: { ...snapshot, file: activePlan?.file ?? snapshot.file }, complete };
      },
    }),
  );

  // -------------------------------------------------------------------------
  // bash: the built-in tool, sandboxed while planning
  // -------------------------------------------------------------------------

  const sandboxReady = () => backend !== undefined && !sandboxBroken;

  function sandboxUnavailableReason(): string {
    return sandboxBroken
      ? "the plan-mode sandbox failed to start in this session"
      : "the plan-mode sandbox (sandbox-exec on macOS, bubblewrap on Linux) is not available on this machine";
  }

  function noticeSandboxUnavailable(ctx: ExtensionContext): void {
    if (sandboxNoticeShown || !ctx.hasUI) return;
    sandboxNoticeShown = true;
    ctx.ui.notify(`Plan mode: bash is disabled while planning because ${sandboxUnavailableReason()}.`, "warning");
  }

  /** Built-in bash with the user's shell settings; the spawn hook sandboxes plan-mode commands. */
  function createBash(cwd: string, settings?: SettingsManager) {
    const shellPath = settings?.getShellPath();
    return createBashToolDefinition(cwd, {
      commandPrefix: settings?.getShellCommandPrefix(),
      shellPath,
      spawnHook: (context) => {
        if (mode !== "plan") return context;
        // Never run unsandboxed in plan mode; tool_call already refuses, this is the backstop.
        if (!backend || sandboxBroken) throw new Error(`Plan mode: bash is disabled because ${sandboxUnavailableReason()}.`);
        return {
          ...context,
          command: wrapCommand(context.command, {
            shell: shellPath ?? "/bin/bash",
            params: sandboxParams(context.env),
            backend,
            env: context.env,
          }),
          env: { ...context.env, GIT_OPTIONAL_LOCKS: "0" },
        };
      },
    });
  }

  let bash = createBash(process.cwd());

  function resultText(content: readonly { type: string; text?: string }[]): string {
    return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  pi.registerTool({
    ...bash,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // The spawn hook runs synchronously inside execute, so this matches its decision.
      const sandboxed = mode === "plan";
      try {
        const result = await bash.execute(toolCallId, params, signal, onUpdate, ctx);
        if (!sandboxed || !isSandboxDenial(resultText(result.content))) return result;
        return { ...result, content: [...result.content, { type: "text", text: SANDBOX_NOTE }] };
      } catch (error) {
        if (!sandboxed || !(error instanceof Error)) throw error;
        const exitCode = Number(/Command exited with code (\d+)$/.exec(error.message)?.[1]);
        if (isProfileError(Number.isNaN(exitCode) ? undefined : exitCode, error.message, backend)) {
          sandboxBroken = true;
          noticeSandboxUnavailable(ctx);
          throw new Error(
            `${error.message}\n\n[plan mode] The sandbox failed to start, so bash is disabled while planning. Continue with read, grep, find and ls, or ask the user.`,
          );
        }
        if (isSandboxDenial(error.message)) throw new Error(`${error.message}\n\n${SANDBOX_NOTE}`);
        throw error;
      }
    },
  });

  // -------------------------------------------------------------------------
  // Execution hand-off
  // -------------------------------------------------------------------------

  // The approving run has fully settled; start execution in a new run.
  //
  // Same session: it must be a user prompt, because only prompts go through
  // before_agent_start and the prompt-section diff (a sendMessage-triggered
  // run would keep the plan_mode section). before_agent_start attaches the
  // execution message.
  //
  // Fresh session: only commands may create sessions, so route through
  // `/plan execute --fresh`. Prompts sent while settling are deferred until
  // the run is fully idle, and extension commands run from prompts.
  pi.on("agent_settled", () => {
    const pending = pendingExecution;
    pendingExecution = undefined;
    if (!pending || mode !== "execute" || !activePlan) return;
    if (pending.fresh) pi.sendUserMessage("/plan execute --fresh", { expandPromptTemplates: true });
    else startExecution();
  });

  async function startFreshSession(ctx: ExtensionCommandContext): Promise<void> {
    const plan = activePlan;
    if (!plan) return;
    // The new session starts from this state: execute mode, the active plan,
    // and a kickoff flag so its first prompt gets the execution message.
    const initialState = toPersisted({ mode: "execute", activePlan: plan, lastProposed, kickoff: true });
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, initialState);
      },
      withSession: async (next) => {
        next.sendUserMessage(`Implement the approved plan: ${plan.title}`).catch((error: unknown) => {
          next.ui.notify(`Could not start executing the plan: ${String(error)}`, "error");
        });
      },
    });
    if (result.cancelled) {
      ctx.ui.notify("New session cancelled. The plan is active here; run /plan execute to continue in this session.", "warning");
    }
  }

  // -------------------------------------------------------------------------
  // Commands and shortcut
  // -------------------------------------------------------------------------

  function planForDisplay(): { title: string; plan: string; steps: PlanStep[]; file?: string } | undefined {
    if (activePlan) return activePlan;
    if (!lastProposed) return undefined;
    return { ...lastProposed, steps: lastProposed.steps.map((text) => ({ text, status: "pending" as const })) };
  }

  async function editPlan(ctx: ExtensionCommandContext): Promise<void> {
    const target = activePlan ?? (lastProposed ? activatePlan(lastProposed) : undefined);
    if (!target) return ctx.ui.notify("No plan to edit yet.", "info");
    const edited = await ctx.ui.editor(`Edit plan: ${target.title}`, renderPlanFile(target));
    if (edited === undefined) return;
    const parsed = parsePlanFile(edited);
    if (parsed.steps.length === 0) {
      return ctx.ui.notify("The edited plan has no steps (`- [ ] 1. …` lines under `## Steps`); nothing changed.", "warning");
    }
    const title = parsed.title ?? target.title;
    const body = parsed.plan || target.plan;
    if (activePlan) {
      activePlan = { ...activePlan, title, plan: body, steps: parsed.steps };
      commitActivePlan(ctx);
    } else {
      lastProposed = { title, plan: body, steps: parsed.steps.map((step) => step.text) };
      persist();
    }
    ctx.ui.notify("Plan updated.", "info");
  }

  async function executeCommand(ctx: ExtensionCommandContext, fresh: boolean): Promise<void> {
    if (!activePlan) {
      if (!lastProposed) return ctx.ui.notify("No plan to execute yet. Ask for one in plan mode first.", "warning");
      await approve(lastProposed, ctx);
    } else if (mode !== "execute") {
      await switchMode("execute", ctx, { quiet: true });
    }
    if (fresh) return startFreshSession(ctx);
    if (!ctx.isIdle()) await ctx.waitForIdle();
    startExecution();
  }

  function clearPlan(ctx: ExtensionContext): void {
    if (!activePlan) return ctx.ui.notify("No active plan.", "info");
    activePlan = undefined;
    applyTools();
    persist();
    updateUI(ctx);
    ctx.ui.notify("Stopped tracking the plan.", "info");
  }

  function showCard(kind: "show" | "status", ctx: ExtensionContext): void {
    const plan = kind === "status" ? activePlan : planForDisplay();
    if (!plan) return ctx.ui.notify(kind === "status" ? "No plan is being executed." : "No plan yet.", "info");
    pi.appendEntry<PlanCard>(CARD_ENTRY_TYPE, {
      kind,
      title: plan.title,
      plan: kind === "show" ? plan.plan : undefined,
      steps: plan.steps,
      file: plan.file,
    });
  }

  pi.registerShortcut("ctrl+shift+tab", {
    description: "Cycle plan / execute mode",
    handler: (ctx) => cycleMode(ctx),
  });

  pi.registerCommand("plan", {
    description: "Plan mode: toggle, on/off, show, status, edit, execute [--fresh], clear, or /plan <prompt>",
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.trimStart())).map((item) => ({
        value: item.value,
        label: item.value,
        description: item.description,
      })),
    handler: async (args, ctx) => {
      const input = args.trim();
      switch (input) {
        case "":
          return cycleMode(ctx);
        case "on":
          return switchMode("plan", ctx);
        case "off":
          return switchMode("execute", ctx);
        case "show":
        case "status":
          return showCard(input, ctx);
        case "edit":
          return editPlan(ctx);
        case "execute":
        case "execute --fresh":
          return executeCommand(ctx, input.endsWith("--fresh"));
        case "clear":
          return clearPlan(ctx);
      }
      await switchMode("plan", ctx);
      // Queued follow-ups skip before_agent_start, so wait and send a fresh prompt.
      if (!ctx.isIdle()) await ctx.waitForIdle();
      pi.sendUserMessage(input);
    },
  });

  // -------------------------------------------------------------------------
  // Transcript rendering
  // -------------------------------------------------------------------------

  pi.registerMessageRenderer<ActivePlan>(EXECUTE_MESSAGE_TYPE, (message, { outputPad }, theme) => {
    const plan = message.details;
    const lines = [
      theme.fg("accent", theme.bold("▶ Executing approved plan")) + (plan ? theme.fg("muted", ` — ${plan.title}`) : ""),
      ...(plan?.steps ?? []).map((step, i) => `  ${renderStepLine(step, i, theme)}`),
    ];
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<PlanCard>(CARD_ENTRY_TYPE, (entry, _options, theme) => {
    const card = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (!card) return box;
    const { finished, total } = planProgress({ title: card.title, plan: "", steps: card.steps, approvedAt: 0 });
    const heading =
      card.kind === "complete"
        ? theme.fg("success", theme.bold(`✓ Plan complete — ${card.title}`))
        : theme.fg("accent", theme.bold(`📋 ${card.title}`)) + theme.fg("dim", `  ${finished}/${total}`);
    const file = card.file ? theme.fg("dim", `\n${relative(process.cwd(), card.file) || card.file}`) : "";
    box.addChild(new Text(heading + file, 0, 0));
    if (card.plan) box.addChild(new Markdown(card.plan, 0, 1, getMarkdownTheme()));
    box.addChild(new Text(card.steps.map((step, i) => `  ${renderStepLine(step, i, theme)}`).join("\n"), 0, 0));
    return box;
  });

  // -------------------------------------------------------------------------
  // Prompt and enforcement
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", (event, ctx) => {
    const sections = event.systemPromptOptions.sections;
    if (mode === "plan") sections[PLAN_SECTION_KEY] = PLAN_MODE_SECTION;
    else delete sections[PLAN_SECTION_KEY];
    if (mode === "execute" && activePlan) sections[ACTIVE_PLAN_SECTION_KEY] = activePlanSection(activePlan, ctx.cwd);
    else delete sections[ACTIVE_PLAN_SECTION_KEY];

    const attach = attachKickoff && mode === "execute" && activePlan !== undefined;
    attachKickoff = false;
    if (kickoffPersisted) {
      kickoffPersisted = false;
      persist(); // drop the kickoff flag so a reload does not attach it again
    }
    if (!attach || !activePlan) return undefined;
    return {
      message: {
        customType: EXECUTE_MESSAGE_TYPE,
        content: executionPrompt(activePlan),
        display: true,
        details: activePlan,
      },
    };
  });

  async function askUser(
    ctx: ExtensionContext,
    request: { title: string; keys: string[]; sessionLabel: string; what: string },
  ): Promise<ToolCallEventResult | undefined> {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Plan mode: ${request.what} needs the user's approval, which is not available here.`,
      };
    }
    const allowOnce = "Allow once";
    const deny = "Deny";
    const choice = await ctx.ui.select(request.title, [allowOnce, request.sessionLabel, deny], { signal: ctx.signal });
    if (choice === allowOnce) return undefined;
    if (choice === request.sessionLabel) {
      for (const key of request.keys) sessionApprovals.add(key);
      return undefined;
    }
    return {
      block: true,
      reason: `The user denied ${request.what} in plan mode. Continue planning without it, or ask the user.`,
    };
  }

  pi.on("tool_call", async (event, ctx) => {
    if (mode !== "plan") return undefined;

    if (WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode is read-only: "${event.toolName}" is unavailable until the user approves a plan via exit_plan_mode.`,
      };
    }

    if (isToolCallEventType("bash", event)) {
      if (!sandboxReady()) {
        noticeSandboxUnavailable(ctx);
        return {
          block: true,
          reason: `Plan mode: bash is disabled because ${sandboxUnavailableReason()}. Continue with read, grep, find and ls, or ask the user.`,
        };
      }
      const command = event.input.command;
      const verdict = classifyBashCommand(command, sessionApprovals);
      if (verdict.kind === "allow") return undefined;
      if (verdict.kind === "deny") {
        return {
          block: true,
          reason: `Plan mode: ${verdict.reason}. The command was not run. Put this step in the plan instead.`,
        };
      }
      const keys = verdict.items.map((item) => item.key);
      return askUser(ctx, {
        title: `Plan mode — run this command?\n\n  ${command}\n\n${verdict.items.map((item) => item.reason).join("\n")}\n\nIt still runs in the sandbox: files stay read-only except ${SANDBOX_WRITABLE}.`,
        keys,
        sessionLabel: `Allow ${keys.map((key) => `"${key}"`).join(", ")} for this session`,
        what: "this command",
      });
    }

    if (READ_ONLY_TOOLS.has(event.toolName) || sessionApprovals.has(`tool:${event.toolName}`)) return undefined;
    const preview = JSON.stringify(event.input);
    return askUser(ctx, {
      title: `Plan mode — allow tool "${event.toolName}"?\n\n  ${preview.length > 300 ? `${preview.slice(0, 300)}…` : preview}`,
      keys: [`tool:${event.toolName}`],
      sessionLabel: `Allow "${event.toolName}" for this session`,
      what: `the "${event.toolName}" tool`,
    });
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  function restoreFromBranch(ctx: ExtensionContext): ReturnType<typeof readPersistedState> {
    const state = readPersistedState(ctx.sessionManager.getBranch());
    activePlan = state?.activePlan;
    lastProposed = state?.lastProposed;
    return state;
  }

  pi.on("session_start", async (event, ctx) => {
    sessionApprovals = new Set();
    pendingExecution = undefined;
    sandboxBroken = false;
    reportedProblems = new Set();
    try {
      bash = createBash(ctx.cwd, SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }));
    } catch {
      bash = createBash(ctx.cwd);
    }

    const flagMode: Mode | undefined =
      pi.getFlag("no-plan") === true ? "execute" : pi.getFlag("plan") === true ? "plan" : undefined;
    const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
    const fallback: Mode = flagMode ?? (interactive ? "plan" : "execute");
    const state = restoreFromBranch(ctx);
    mode = event.reason === "startup" && flagMode ? flagMode : (state?.mode ?? fallback);
    attachKickoff = state?.kickoff === true;
    kickoffPersisted = attachKickoff;

    applyTools();
    updateUI(ctx);
    if (mode === "plan" && !sandboxReady()) noticeSandboxUnavailable(ctx);

    stopLegacyKeyListener?.();
    stopLegacyKeyListener =
      ctx.mode === "tui"
        ? ctx.ui.onTerminalInput((data) => {
            if (data !== LEGACY_CTRL_SHIFT_TAB) return undefined;
            void cycleMode(ctx);
            return { consume: true };
          })
        : undefined;

    // A new session starts on its mode's default model; resumed, reloaded and
    // forked sessions keep their model, and --model / --provider wins at startup.
    const explicitModel = event.reason === "startup" && modelFlagGiven(process.argv);
    if (!explicitModel && isFreshSession(ctx.sessionManager.getBranch())) await applyModeDefault(ctx);
  });

  // /tree navigation: adopt the state saved on the new branch.
  pi.on("session_tree", (_event, ctx) => {
    const state = restoreFromBranch(ctx);
    if (state) mode = state.mode;
    applyTools();
    updateUI(ctx);
  });

  // Theme may have switched (light/dark); re-render the badge colors.
  pi.on("agent_start", (_event, ctx) => updateUI(ctx));
  pi.on("agent_end", (_event, ctx) => updateUI(ctx));

  pi.on("session_shutdown", () => {
    stopLegacyKeyListener?.();
    stopLegacyKeyListener = undefined;
  });
}
