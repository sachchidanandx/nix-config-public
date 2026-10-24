// Run: node --test pi/agent/extensions/ask-user/*.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AskQuestion,
  answerText,
  DISMISSED_TEXT,
  formatResult,
  isAnswered,
  NO_UI_TEXT,
  validateQuestions,
} from "./format.ts";

const q = (header: string, extra: Partial<AskQuestion> = {}): AskQuestion => ({
  question: `Which ${header}?`,
  header,
  options: [{ label: "A" }, { label: "B", description: "the other one" }],
  ...extra,
});

describe("validateQuestions", () => {
  it("accepts 1-4 well-formed questions", () => {
    assert.equal(validateQuestions([q("One")]), undefined);
    assert.equal(validateQuestions([q("1"), q("2"), q("3"), q("4")]), undefined);
  });
  it("rejects bad counts, missing text and duplicate headers", () => {
    assert.match(validateQuestions([]) ?? "", /ask 1-4 questions \(got 0\)/);
    assert.match(validateQuestions([q("1"), q("2"), q("3"), q("4"), q("5")]) ?? "", /got 5/);
    assert.match(validateQuestions([q("X", { options: [{ label: "only" }] })]) ?? "", /needs 2-4 options \(got 1\)/);
    assert.match(validateQuestions([q("X"), q("X")]) ?? "", /repeats the header "X"/);
    assert.match(validateQuestions([q("X", { question: " " })]) ?? "", /no question text/);
    assert.match(validateQuestions([q("", {})]) ?? "", /no header/);
    assert.match(validateQuestions([q("X", { options: [{ label: "" }, { label: "b" }] })]) ?? "", /without a label/);
  });
});

describe("answers", () => {
  it("formats single, multiple and typed answers", () => {
    assert.equal(answerText({ header: "h", question: "q", selected: ["A"] }), "A");
    assert.equal(answerText({ header: "h", question: "q", selected: ["A", "B"] }), "A, B");
    assert.equal(answerText({ header: "h", question: "q", selected: [], typed: " my own " }), '(typed) "my own"');
    assert.equal(answerText({ header: "h", question: "q", selected: ["A"], typed: "and more" }), 'A; typed: "and more"');
    assert.equal(answerText({ header: "h", question: "q", selected: [] }), "(no answer)");
  });
  it("knows when a question is answered", () => {
    assert.equal(isAnswered(undefined), false);
    assert.equal(isAnswered({ header: "h", question: "q", selected: [], typed: "  " }), false);
    assert.equal(isAnswered({ header: "h", question: "q", selected: [], typed: "x" }), true);
    assert.equal(isAnswered({ header: "h", question: "q", selected: ["A"] }), true);
  });
});

describe("formatResult", () => {
  it("lists answers by header", () => {
    const text = formatResult({
      outcome: "answered",
      questions: [q("Scope"), q("Tests")],
      answers: [
        { header: "Scope", question: "Which Scope?", selected: ["A"] },
        { header: "Tests", question: "Which Tests?", selected: [], typed: "none" },
      ],
    });
    assert.equal(text, 'User answers:\n- Scope: A\n- Tests: (typed) "none"');
  });
  it("explains dismissal and missing UI", () => {
    assert.equal(formatResult({ outcome: "dismissed", questions: [], answers: [] }), DISMISSED_TEXT);
    assert.equal(formatResult({ outcome: "no-ui", questions: [], answers: [] }), NO_UI_TEXT);
  });
});
