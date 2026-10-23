import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error the browser plugin is plain ESM without a declaration file
const examUi = await import("../plugins/shared/exam-ui.mjs") as {
  splitPrompt: (question: { prompt: string }, section: string) => { instruction: string; title: string; body: string };
  createExamHtml: (input: Record<string, unknown>) => string;
  findQuoteOffset: (source: string, start: number, quote: string) => number;
};

describe("shared exam UI", () => {
  it("parses a prompt with blanks consistently across repeated calls", () => {
    const prompt = { prompt: "Complete the notes.\nName ____\nMore text" };
    const expected = { instruction: "Complete the notes.", title: "", body: "Name ____\nMore text" };
    assert.deepEqual(examUi.splitPrompt(prompt, "reading"), expected);
    assert.deepEqual(examUi.splitPrompt(prompt, "reading"), expected);
    assert.deepEqual(examUi.splitPrompt(prompt, "reading"), expected);
  });

  it("relocates an annotation quote when feedback nodes shift the stored offsets", () => {
    const source = "one two one two three";
    assert.equal(examUi.findQuoteOffset(source, 14, "three"), 16);
    assert.equal(examUi.findQuoteOffset(source, 0, "two"), 4);
    assert.equal(examUi.findQuoteOffset(source, 14, "one"), 8);
    assert.equal(examUi.findQuoteOffset("xx alpha yy", 3, " alpha "), 3);
    assert.equal(examUi.findQuoteOffset(source, 0, "missing"), -1);
    assert.equal(examUi.findQuoteOffset(source, 0, "   "), -1);
  });

  it("shows the transcript only after a result exists", () => {    const activity = {
      id: "listening-transcript-gate",
      pluginId: "listening",
      title: "Listening",
      description: "",
      minutes: 30,
      difficulty: 1,
      sample: false,
      transcript: "A secret transcript.",
      questions: [{
        id: "q1",
        prompt: "Question 1\nChoose the answer.",
        kind: "choice",
        options: ["A", "B"],
        skillTags: ["listening.detail"],
        correctAnswer: "A",
        evidence: "Evidence.",
        explanation: "Explanation.",
      }],
    };
    const draft = {
      attemptId: "attempt-1",
      activityId: activity.id,
      mode: "practice",
      answers: {},
      hintedQuestionIds: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const before = examUi.createExamHtml({ activity, draft, section: "listening" });
    assert.equal(before.includes("data-transcript-toggle"), false);
    const result = {
      ...draft,
      pluginId: "listening",
      submittedAt: new Date().toISOString(),
      score: 0,
      total: 1,
      responses: [],
      sample: false,
    };
    const after = examUi.createExamHtml({ activity, draft, result, section: "listening" });
    assert.equal(after.includes("data-transcript-toggle"), true);
  });
});
