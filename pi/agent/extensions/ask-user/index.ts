/**
 * ask_user: the model asks the user 1-4 structured clarifying questions and
 * gets the answers back in the same turn (like Claude Code's AskUserQuestion).
 *
 * Each question has a short header, 2-4 options and optionally multiSelect;
 * every question also offers "Type something…" for a free-text answer.
 *
 *   TUI   questionnaire: ↑↓ move, Enter choose, Space toggle (multi-select),
 *         Tab / Shift+Tab (or ←→) switch questions, Submit tab, Esc dismiss
 *   RPC   one select (and input for typed answers) per question
 *   none  (print/JSON mode) tells the model to state assumptions and continue
 *
 * Plan mode lists ask_user as read-only, so it never needs approval there.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type AskAnswer,
  type AskDetails,
  type AskQuestion,
  answerText,
  formatResult,
  isAnswered,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  TOOL_NAME,
  TYPE_SOMETHING,
  validateQuestions,
} from "./format.ts";

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: "The full question, ending with a question mark",
      }),
      header: Type.String({
        description:
          "Very short label (max ~12 chars) shown as the tab title and in the answer, e.g. 'Scope', 'Auth method'",
      }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Short choice text (1-5 words)" }),
          description: Type.Optional(
            Type.String({ description: "What this choice means or implies" }),
          ),
        }),
        {
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          description: "2-4 distinct choices; do not add an 'Other' option",
        },
      ),
      multiSelect: Type.Optional(
        Type.Boolean({
          description: "Allow choosing several options (default false)",
        }),
      ),
    }),
    { minItems: 1, maxItems: MAX_QUESTIONS, description: "1-4 questions" },
  ),
});

type Outcome = { answers: AskAnswer[] } | undefined;

// ---------------------------------------------------------------------------
// TUI questionnaire
// ---------------------------------------------------------------------------

interface QuestionState {
  cursor: number;
  selected: Set<number>;
  typed?: string;
}

function toAnswer(question: AskQuestion, state: QuestionState): AskAnswer {
  return {
    header: question.header,
    question: question.question,
    selected: [...state.selected]
      .sort((a, b) => a - b)
      .map((i) => question.options[i].label),
    typed: state.typed?.trim() || undefined,
  };
}

function createQuestionnaire(
  questions: AskQuestion[],
  tui: TUI,
  theme: Theme,
  done: (outcome: Outcome) => void,
) {
  const states: QuestionState[] = questions.map(() => ({
    cursor: 0,
    selected: new Set<number>(),
  }));
  // Tabs and a Submit step are needed unless it is one single-choice question.
  const needsSubmit =
    questions.length > 1 || questions.some((q) => q.multiSelect);
  const submitTab = questions.length;
  let tab = 0;
  let typing = false;
  let warning: string | undefined;
  let cache: string[] | undefined;

  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  const refresh = () => {
    cache = undefined;
    tui.requestRender();
  };
  const answered = (i: number) => isAnswered(toAnswer(questions[i], states[i]));
  const allAnswered = () => questions.every((_, i) => answered(i));
  const finish = () =>
    done({ answers: questions.map((q, i) => toAnswer(q, states[i])) });

  function goTo(next: number) {
    tab = (next + submitTab + 1) % (submitTab + 1);
    typing = false;
    warning = undefined;
    refresh();
  }

  function advance() {
    if (!needsSubmit) return finish();
    goTo(tab + 1);
  }

  editor.onSubmit = (value) => {
    const state = states[tab];
    state.typed = value.trim() || undefined;
    editor.setText("");
    typing = false;
    // Single choice: a typed answer replaces the chosen option and moves on.
    // Multi-select: it is added to the selection; Tab moves on.
    if (state.typed && !questions[tab].multiSelect) {
      state.selected.clear();
      return advance();
    }
    refresh();
  };

  function handleInput(data: string) {
    if (typing) {
      if (matchesKey(data, Key.escape)) {
        typing = false;
        editor.setText("");
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }

    if (matchesKey(data, Key.escape)) return done(undefined);
    if (needsSubmit) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
        return goTo(tab + 1);
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))
        return goTo(tab - 1);
    }

    if (tab === submitTab) {
      if (!matchesKey(data, Key.enter)) return;
      if (allAnswered()) return finish();
      warning = "Answer every question first (or press Esc to dismiss).";
      return refresh();
    }

    const question = questions[tab];
    const state = states[tab];
    const rows = question.options.length + 1; // + "Type something…"
    if (matchesKey(data, Key.up)) {
      state.cursor = (state.cursor - 1 + rows) % rows;
      return refresh();
    }
    if (matchesKey(data, Key.down)) {
      state.cursor = (state.cursor + 1) % rows;
      return refresh();
    }
    const onTyped = state.cursor === question.options.length;
    const toggle = matchesKey(data, Key.space);
    if (!matchesKey(data, Key.enter) && !toggle) return;
    if (onTyped) {
      typing = true;
      editor.setText(state.typed ?? "");
      return refresh();
    }
    if (question.multiSelect) {
      if (state.selected.has(state.cursor)) state.selected.delete(state.cursor);
      else state.selected.add(state.cursor);
      return refresh();
    }
    if (toggle) return;
    state.selected = new Set([state.cursor]);
    state.typed = undefined;
    advance();
  }

  function render(width: number): string[] {
    if (cache) return cache;
    const w = Math.max(10, width);
    const lines: string[] = [];
    const add = (text: string, indent = " ") => {
      const wrapped = wrapTextWithAnsi(
        text,
        Math.max(1, w - visibleWidth(indent)),
      );
      wrapped.forEach((line, i) =>
        lines.push(
          `${i === 0 ? indent : " ".repeat(visibleWidth(indent))}${line}`,
        ),
      );
    };

    lines.push(theme.fg("accent", "─".repeat(w)));
    if (needsSubmit) {
      const tabs = questions.map((q, i) => {
        const label = ` ${answered(i) ? "■" : "□"} ${truncateToWidth(q.header, 16)} `;
        if (i === tab) return theme.bg("selectedBg", theme.fg("text", label));
        return theme.fg(answered(i) ? "success" : "muted", label);
      });
      const submit = " ✓ Submit ";
      tabs.push(
        tab === submitTab
          ? theme.bg("selectedBg", theme.fg("text", submit))
          : theme.fg(allAnswered() ? "success" : "dim", submit),
      );
      add(tabs.join(" "));
      lines.push("");
    }

    if (tab === submitTab) {
      add(theme.fg("accent", theme.bold("Review your answers")));
      lines.push("");
      questions.forEach((q, i) => {
        const answer = toAnswer(q, states[i]);
        const text = isAnswered(answer)
          ? theme.fg("text", answerText(answer))
          : theme.fg("warning", "(unanswered)");
        add(`${theme.fg("muted", `${q.header}: `)}${text}`);
      });
      lines.push("");
      add(
        warning
          ? theme.fg("warning", warning)
          : theme.fg(
              allAnswered() ? "success" : "dim",
              "Press Enter to submit",
            ),
      );
    } else {
      const question = questions[tab];
      const state = states[tab];
      add(theme.fg("text", theme.bold(question.question)));
      if (question.multiSelect) add(theme.fg("dim", "Choose one or more"));
      lines.push("");
      const rows = [
        ...question.options,
        { label: TYPE_SOMETHING, description: undefined },
      ];
      rows.forEach((option, i) => {
        const current = i === state.cursor;
        const isTyped = i === question.options.length;
        const mark = isTyped
          ? state.typed
            ? "✎"
            : " "
          : question.multiSelect
            ? state.selected.has(i)
              ? "☑"
              : "☐"
            : state.selected.has(i)
              ? "●"
              : "○";
        const pointer = current ? theme.fg("accent", "❯ ") : "  ";
        const label =
          isTyped && state.typed
            ? `${option.label} "${state.typed}"`
            : option.label;
        add(
          `${pointer}${theme.fg(current ? "accent" : "text", `${mark} ${i + 1}. ${label}`)}`,
          " ",
        );
        if (option.description)
          add(theme.fg("muted", option.description), "        ");
      });
      if (typing) {
        lines.push("");
        add(
          theme.fg("muted", "Your answer (Enter to confirm, Esc to go back):"),
        );
        for (const line of editor.render(Math.max(1, w - 2)))
          lines.push(` ${line}`);
      }
    }

    lines.push("");
    if (!typing) {
      const keys = [
        "↑↓ move",
        questions[tab]?.multiSelect ? "Space/Enter toggle" : "Enter choose",
        ...(needsSubmit ? ["Tab/←→ switch"] : []),
        "Esc dismiss",
      ];
      add(theme.fg("dim", keys.join(" • ")));
    }
    lines.push(theme.fg("accent", "─".repeat(w)));
    cache = lines;
    return lines;
  }

  return { render, handleInput, invalidate: () => (cache = undefined) };
}

// ---------------------------------------------------------------------------
// RPC fallback: one dialog per question
// ---------------------------------------------------------------------------

const optionText = (option: { label: string; description?: string }) =>
  option.description ? `${option.label} — ${option.description}` : option.label;

async function askWithDialogs(
  questions: AskQuestion[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const answers: AskAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const title = `${question.header} (${index + 1}/${questions.length}): ${question.question}`;
    const state: QuestionState = { cursor: 0, selected: new Set() };
    const typeText = async () => {
      const typed = await ctx.ui.input(question.question, "Your answer", {
        signal,
      });
      if (typed === undefined) return false;
      state.typed = typed;
      return true;
    };
    if (!question.multiSelect) {
      const labels = [...question.options.map(optionText), TYPE_SOMETHING];
      const choice = await ctx.ui.select(title, labels, { signal });
      if (choice === undefined) return undefined;
      const chosen = labels.indexOf(choice);
      if (chosen === question.options.length) {
        if (!(await typeText())) return undefined;
      } else state.selected.add(chosen);
    } else {
      const DONE = "✓ Done";
      for (;;) {
        const labels = [
          ...question.options.map(
            (o, i) => `${state.selected.has(i) ? "☑" : "☐"} ${optionText(o)}`,
          ),
          state.typed ? `${TYPE_SOMETHING} ("${state.typed}")` : TYPE_SOMETHING,
          DONE,
        ];
        const choice = await ctx.ui.select(
          `${title} (choose one or more, then Done)`,
          labels,
          { signal },
        );
        if (choice === undefined) return undefined;
        const chosen = labels.indexOf(choice);
        if (choice === DONE) {
          if (isAnswered(toAnswer(question, state))) break;
          ctx.ui.notify(
            "Choose at least one option, or type an answer.",
            "warning",
          );
        } else if (chosen === question.options.length) {
          if (!(await typeText())) return undefined;
        } else if (state.selected.has(chosen)) state.selected.delete(chosen);
        else state.selected.add(chosen);
      }
    }
    answers.push(toAnswer(question, state));
  }
  return { answers };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask user",
    description:
      "Ask the user 1-4 multiple-choice questions and wait for the answers. Use it for decisions only the user can make " +
      "(requirements, preferences, scope, trade-offs), not for facts you can find out yourself. Each question has a short " +
      "header and 2-4 options; the user can also type their own answer, so never add an 'Other' option.",
    promptSnippet:
      "Ask the user structured multiple-choice questions and get the answers in the same turn",
    promptGuidelines: [
      "Use ask_user when a decision is the user's to make (requirements, preferences, scope, trade-offs); first find out what you can yourself by reading code or running read-only commands.",
      "Batch related questions into one ask_user call (at most 4), each with 2-4 concrete, distinct options; put the recommended option first and say why in its description.",
    ],
    parameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions: AskQuestion[] = params.questions.map((q) => ({
        question: q.question.trim(),
        header: q.header.trim(),
        options: q.options.map((o) => ({
          label: o.label.trim(),
          description: o.description?.trim() || undefined,
        })),
        multiSelect: q.multiSelect === true,
      }));
      const invalid = validateQuestions(questions);
      if (invalid) throw new Error(invalid);

      const result = (
        outcome: AskDetails["outcome"],
        answers: AskAnswer[] = [],
      ) => {
        const details: AskDetails = { outcome, questions, answers };
        return {
          content: [{ type: "text" as const, text: formatResult(details) }],
          details,
        };
      };

      if (!ctx.hasUI) return result("no-ui");

      let outcome: Outcome;
      if (ctx.mode === "tui") {
        outcome = await ctx.ui.custom<Outcome>(
          (tui, theme, _keybindings, done) => {
            let settled = false;
            const finish = (value: Outcome) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener("abort", onAbort);
              done(value);
            };
            const onAbort = () => finish(undefined);
            signal?.addEventListener("abort", onAbort, { once: true });
            return createQuestionnaire(questions, tui, theme, finish);
          },
        );
      } else {
        outcome = await askWithDialogs(questions, ctx, signal);
      }
      return outcome
        ? result("answered", outcome.answers)
        : result("dismissed");
    },

    renderCall(args, theme) {
      const questions = (args.questions ?? []) as Partial<AskQuestion>[];
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        `${questions.length} question${questions.length === 1 ? "" : "s"}`,
      );
      for (const q of questions) {
        text += `\n  ${theme.fg("accent", q.header ?? "")}${theme.fg("dim", q.question ? ` ${q.question}` : "")}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskDetails | undefined;
      if (!details || details.outcome === "no-ui") {
        const first = result.content[0];
        return new Text(
          theme.fg("dim", first?.type === "text" ? first.text : ""),
          0,
          0,
        );
      }
      if (details.outcome === "dismissed")
        return new Text(theme.fg("warning", "Dismissed"), 0, 0);
      const lines = details.answers.map(
        (a) =>
          `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${answerText(a)}`,
      );
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
