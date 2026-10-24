/**
 * Plan files: <cwd>/.pi/plans/YYYY-MM-DD-HHMM-<slug>.md
 *
 *   # <title>
 *
 *   > Status: in progress · 3/7 · approved 2026-09-30 17:45
 *
 *   ## Steps
 *
 *   - [x] 1. Done step
 *   - [ ] 2. Current step _(in progress)_
 *   - [x] 3. ~~Skipped step~~ _(skipped)_
 *     - optional note
 *   - [ ] 4. Pending step
 *
 *   ## Plan
 *
 *   <plan markdown>
 *
 * Written by the extension (never by the agent) on approval and on every
 * progress change. parsePlanFile() reads the same format back for /plan edit,
 * and also accepts `[~]` (in progress) and `[-]` (skipped) when hand-edited.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ActivePlan, isPlanComplete, type PlanStep, planProgress, type StepStatus } from "./state.ts";

export const PLANS_DIR = join(".pi", "plans");

const pad = (n: number) => String(n).padStart(2, "0");

export function planSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "plan";
}

export function planFileName(title: string, date: Date): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}-${planSlug(title)}.md`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderStep(step: PlanStep, index: number): string {
  const n = `${index + 1}.`;
  const text = step.text.replace(/\n+/g, " ");
  let line: string;
  switch (step.status) {
    case "done":
      line = `- [x] ${n} ${text}`;
      break;
    case "skipped":
      line = `- [x] ${n} ~~${text}~~ _(skipped)_`;
      break;
    case "in_progress":
      line = `- [ ] ${n} ${text} _(in progress)_`;
      break;
    default:
      line = `- [ ] ${n} ${text}`;
  }
  return step.note ? `${line}\n  - ${step.note.replace(/\n+/g, " ")}` : line;
}

export function renderPlanFile(plan: ActivePlan): string {
  const { finished, total } = planProgress(plan);
  const status = isPlanComplete(plan) ? "complete" : finished === 0 ? "not started" : "in progress";
  return [
    `# ${plan.title}`,
    "",
    `> Status: ${status} · ${finished}/${total} · approved ${formatDate(plan.approvedAt)}`,
    "",
    "## Steps",
    "",
    ...plan.steps.map(renderStep),
    "",
    "## Plan",
    "",
    // Plans often start with their own "## Plan" heading; don't repeat it.
    plan.plan.trim().replace(/^#{1,3}\s+plan\s*\n+/i, ""),
    "",
  ].join("\n");
}

export interface ParsedPlanFile {
  title?: string;
  plan: string;
  steps: PlanStep[];
}

const STEP_LINE = /^\s*[-*]\s+\[([ xX~-])\]\s+(?:\d+[.)]\s+)?(.*)$/;
const NOTE_LINE = /^\s{2,}[-*]\s+(.*)$/;

function parseStep(marker: string, rawText: string): PlanStep {
  let text = rawText.trim();
  let status: StepStatus = marker === " " ? "pending" : "done";
  if (marker === "~") status = "in_progress";
  if (marker === "-") status = "skipped";
  if (/_\(in progress\)_$/.test(text)) {
    status = "in_progress";
    text = text.replace(/\s*_\(in progress\)_$/, "");
  }
  if (/_\(skipped\)_$/.test(text)) {
    status = "skipped";
    text = text.replace(/\s*_\(skipped\)_$/, "");
  }
  text = text.replace(/^~~(.*)~~$/, "$1").trim();
  return { text, status };
}

export function parsePlanFile(content: string): ParsedPlanFile {
  const lines = content.split("\n");
  const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();

  const stepsStart = lines.findIndex((line) => /^##\s+Steps\s*$/i.test(line));
  const planStart = lines.findIndex((line) => /^##\s+Plan\s*$/i.test(line));

  const steps: PlanStep[] = [];
  if (stepsStart >= 0) {
    const end = planStart > stepsStart ? planStart : lines.length;
    for (const line of lines.slice(stepsStart + 1, end)) {
      const step = line.match(STEP_LINE);
      if (step) {
        const parsed = parseStep(step[1], step[2]);
        if (parsed.text) steps.push(parsed);
        continue;
      }
      const note = line.match(NOTE_LINE);
      const last = steps[steps.length - 1];
      if (note && last) last.note = last.note ? `${last.note} ${note[1].trim()}` : note[1].trim();
    }
  }

  const plan = planStart >= 0 ? lines.slice(planStart + 1).join("\n").trim() : "";
  return { title: title || undefined, plan, steps };
}

/**
 * Write the plan file, creating <cwd>/.pi/plans/ as needed. Reuses plan.file
 * when set; otherwise picks a new name (suffixing -2, -3, ... on collision).
 * Returns the absolute path.
 */
export function writePlanFile(cwd: string, plan: ActivePlan): string {
  let file = plan.file;
  if (!file) {
    const dir = join(cwd, PLANS_DIR);
    mkdirSync(dir, { recursive: true });
    const base = planFileName(plan.title, new Date(plan.approvedAt)).replace(/\.md$/, "");
    file = join(dir, `${base}.md`);
    for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.md`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPlanFile({ ...plan, file }));
  return file;
}
