// Run: node --test pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parsePlanFile, planFileName, planSlug, renderPlanFile, writePlanFile } from "./plan-file.ts";
import { activePlanSection, executionPrompt, PLAN_MODE_SECTION } from "./prompts.ts";
import {
  type ActivePlan,
  activatePlan,
  currentStepIndex,
  executeModeTools,
  isPlanComplete,
  planModeTools,
  planProgress,
  READ_ONLY_TOOLS,
  readPersistedState,
  STATE_ENTRY_TYPE,
  updatePlanStep,
  WRITE_TOOLS,
} from "./state.ts";

const proposal = { title: "Add widget", plan: "## Plan\nDo **it**.", steps: ["One", "Two", "Three"] };
const entry = (data: unknown) => ({ type: "custom", customType: STATE_ENTRY_TYPE, data }) as never;

describe("state", () => {
  it("reads the latest v2 entry and tolerates v1 entries", () => {
    assert.equal(readPersistedState([]), undefined);
    assert.deepEqual(readPersistedState([entry({ version: 1, mode: "plan" })]), { mode: "plan" });
    const active = activatePlan(proposal, undefined, 0);
    const state = readPersistedState([
      entry({ version: 1, mode: "plan" }),
      entry({ version: 2, mode: "execute", activePlan: active, kickoff: true }),
      { type: "message" } as never,
    ]);
    assert.equal(state?.mode, "execute");
    assert.equal(state?.activePlan?.title, "Add widget");
    assert.equal(state?.kickoff, true);
  });

  it("keeps finished steps with identical text when a plan is revised", () => {
    let active = activatePlan(proposal);
    active = updatePlanStep(active, 1, "done");
    active = updatePlanStep(active, 2, "in_progress");
    const revised = activatePlan({ ...proposal, steps: ["One", "Two", "Two and a half", "Three"] }, active);
    assert.deepEqual(
      revised.steps.map((s) => s.status),
      ["done", "pending", "pending", "pending"],
    );
    assert.equal(revised.file, undefined);
  });

  it("tracks progress, the current step and completion", () => {
    let active = activatePlan(proposal);
    assert.equal(currentStepIndex(active), 0);
    active = updatePlanStep(active, 2, "in_progress");
    assert.equal(currentStepIndex(active), 1);
    active = updatePlanStep(active, 1, "done");
    active = updatePlanStep(active, 2, "skipped", "  not needed ");
    assert.deepEqual(planProgress(active), { finished: 2, total: 3 });
    assert.equal(active.steps[1].note, "not needed");
    assert.equal(isPlanComplete(active), false);
    active = updatePlanStep(active, 3, "done");
    assert.equal(isPlanComplete(active), true);
    assert.equal(currentStepIndex(active), -1);
    assert.throws(() => updatePlanStep(active, 4, "done"), /Step 4 does not exist/);
  });

  it("manages its own tools per mode", () => {
    assert.deepEqual(planModeTools(["read", "bash", "edit", "write", "plan_update", "get_nvim_state"]), [
      "read",
      "bash",
      "get_nvim_state",
      "grep",
      "find",
      "ls",
      "exit_plan_mode",
    ]);
    assert.deepEqual(executeModeTools(["read", "bash", "edit", "exit_plan_mode"], false), ["read", "bash", "edit"]);
    assert.deepEqual(executeModeTools(["read", "plan_update"], true), ["read", "plan_update"]);
  });

  it("pre-approves read-only MCP tools and keeps writes gated", () => {
    for (const tool of [
      "codemode",
      "list_mcp_resources",
      "read_mcp_resource",
      "mcp__slack__slack_read_channel",
      "mcp__slack__slack_search_public",
      "mcp__atlassian__getJiraIssue",
      "mcp__atlassian__executeRead",
      "mcp__chrome_devtools__navigate_page",
      "mcp__chrome_devtools__take_snapshot",
    ]) {
      assert.ok(READ_ONLY_TOOLS.has(tool), `${tool} should be pre-approved`);
    }
    for (const tool of [
      "mcp__slack__slack_send_message",
      "mcp__atlassian__createJiraIssue",
      "mcp__atlassian__executeWrite",
      "mcp__atlassian__executeDestructive",
      "mcp__chrome_devtools__click",
      "mcp__chrome_devtools__evaluate_script",
      "mcp__chrome_devtools__take_heapsnapshot",
      "mcp__chrome_devtools__close_page",
    ]) {
      assert.ok(!READ_ONLY_TOOLS.has(tool), `${tool} should still ask`);
      assert.ok(!WRITE_TOOLS.has(tool), `${tool} should ask, not be blocked outright`);
    }
  });
});

describe("plan file", () => {
  const plan: ActivePlan = {
    ...activatePlan(proposal, undefined, new Date(2026, 8, 30, 17, 5).getTime()),
  };

  it("names files by date and slug", () => {
    assert.equal(planSlug("Fix: the  Footer/Status line!"), "fix-the-footer-status-line");
    assert.equal(planSlug("!!!"), "plan");
    assert.equal(planFileName("Add widget", new Date(2026, 8, 30, 17, 5)), "2026-09-30-1705-add-widget.md");
  });

  it("round-trips titles, statuses, notes and the plan body", () => {
    let active = updatePlanStep(plan, 1, "done");
    active = updatePlanStep(active, 2, "in_progress");
    active = updatePlanStep(active, 3, "skipped", "covered by step 1");
    const text = renderPlanFile(active);
    assert.match(text, /^# Add widget$/m);
    assert.match(text, /> Status: complete · 2\/3|> Status: in progress · 2\/3/);
    assert.match(text, /^- \[x\] 1\. One$/m);
    assert.match(text, /^- \[ \] 2\. Two _\(in progress\)_$/m);
    assert.match(text, /^- \[x\] 3\. ~~Three~~ _\(skipped\)_$/m);
    const parsed = parsePlanFile(text);
    assert.equal(parsed.title, "Add widget");
    assert.equal(parsed.plan, "Do **it**."); // the body's own "## Plan" heading is not repeated
    assert.equal(text.match(/^## Plan$/gm)?.length, 1);
    assert.deepEqual(parsed.steps, [
      { text: "One", status: "done" },
      { text: "Two", status: "in_progress" },
      { text: "Three", status: "skipped", note: "covered by step 1" },
    ]);
  });

  it("accepts hand-edited markers and unnumbered steps", () => {
    const parsed = parsePlanFile("# T\n## Steps\n- [~] Doing\n* [-] Dropped\n- [X] 2) Done\n- plain bullet\n## Plan\nbody");
    assert.deepEqual(
      parsed.steps.map((s) => [s.text, s.status]),
      [
        ["Doing", "in_progress"],
        ["Dropped", "skipped"],
        ["Done", "done"],
      ],
    );
  });

  it("writes into <cwd>/.pi/plans and avoids overwriting other plans", () => {
    const cwd = mkdtempSync(join(tmpdir(), "plan-mode-test-"));
    try {
      const first = writePlanFile(cwd, plan);
      const second = writePlanFile(cwd, plan);
      assert.equal(first, join(cwd, ".pi", "plans", "2026-09-30-1705-add-widget.md"));
      assert.equal(second, join(cwd, ".pi", "plans", "2026-09-30-1705-add-widget-2.md"));
      const rewritten = writePlanFile(cwd, { ...updatePlanStep(plan, 1, "done"), file: first });
      assert.equal(rewritten, first);
      assert.match(readFileSync(first, "utf8"), /^- \[x\] 1\. One$/m);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("prompts", () => {
  it("puts statuses in the active_plan section and names the next step", () => {
    const active = updatePlanStep(activatePlan(proposal), 1, "done");
    const section = activePlanSection({ ...active, file: "/repo/.pi/plans/x.md" }, "/repo");
    assert.match(section, /Plan file: \.pi\/plans\/x\.md/);
    assert.match(section, /1\. \[done\] One\n2\. \[pending\] Two/);
    assert.match(executionPrompt(active), /Start with step 2: Two/);
  });

  it("asks for implementation-ready plans and plan-following execution", () => {
    assert.match(PLAN_MODE_SECTION, /before\/after snippets/);
    assert.match(PLAN_MODE_SECTION, /assume the implementer cannot see them/);
    const section = activePlanSection(activatePlan(proposal), "/repo");
    assert.match(section, /Follow the plan as written/);
    assert.match(section, /copy it from the path the plan gives/);
    assert.match(executionPrompt(activatePlan(proposal)), /following the plan's file paths, code snippets and patterns/);
  });
});
