/**
 * ask_user: types, validation and the text sent back to the model.
 * Kept free of UI code so it can be unit-tested.
 */

export const TOOL_NAME = "ask_user";
export const TYPE_SOMETHING = "Type something…";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  header: string;
  question: string;
  /** Labels of the chosen options (one for single choice). */
  selected: string[];
  /** Free text the user typed via "Type something…". */
  typed?: string;
}

export type AskOutcome = "answered" | "dismissed" | "no-ui";

export interface AskDetails {
  outcome: AskOutcome;
  questions: AskQuestion[];
  answers: AskAnswer[];
}

export const NO_UI_TEXT =
  "No user is available to answer questions here. State your assumptions explicitly and continue.";
export const DISMISSED_TEXT =
  "The user dismissed the questions without answering. Continue with your best judgement (state your assumptions), or ask in plain text.";

/** Problems with the questions, as one message for the model; undefined when valid. */
export function validateQuestions(
  questions: readonly AskQuestion[],
): string | undefined {
  const problems: string[] = [];
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
    problems.push(`ask 1-${MAX_QUESTIONS} questions (got ${questions.length})`);
  }
  const headers = new Set<string>();
  questions.forEach((q, i) => {
    const name = `question ${i + 1}`;
    if (!q.question?.trim()) problems.push(`${name} has no question text`);
    if (!q.header?.trim()) problems.push(`${name} has no header`);
    else if (headers.has(q.header.trim()))
      problems.push(`${name} repeats the header "${q.header}"`);
    else headers.add(q.header.trim());
    const count = q.options?.length ?? 0;
    if (count < MIN_OPTIONS || count > MAX_OPTIONS) {
      problems.push(
        `${name} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (got ${count})`,
      );
    }
    if (q.options?.some((o) => !o.label?.trim()))
      problems.push(`${name} has an option without a label`);
  });
  return problems.length
    ? `Invalid ask_user call: ${problems.join("; ")}.`
    : undefined;
}

export function isAnswered(answer: AskAnswer | undefined): boolean {
  return (
    answer !== undefined &&
    (answer.selected.length > 0 || !!answer.typed?.trim())
  );
}

/** One answer as text: `A, B; typed: "…"`. */
export function answerText(answer: AskAnswer): string {
  const parts: string[] = [];
  if (answer.selected.length) parts.push(answer.selected.join(", "));
  if (answer.typed?.trim())
    parts.push(
      `${answer.selected.length ? "typed: " : "(typed) "}"${answer.typed.trim()}"`,
    );
  return parts.length ? parts.join("; ") : "(no answer)";
}

/** Text sent back to the model. */
export function formatResult(details: AskDetails): string {
  if (details.outcome === "no-ui") return NO_UI_TEXT;
  if (details.outcome === "dismissed") return DISMISSED_TEXT;
  return [
    "User answers:",
    ...details.answers.map((a) => `- ${a.header}: ${answerText(a)}`),
  ].join("\n");
}
