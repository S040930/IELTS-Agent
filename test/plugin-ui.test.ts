import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error the browser plugin is plain ESM without a declaration file
const examUi = await import("../plugins/shared/exam-ui.mjs") as {
  splitPrompt: (question: { prompt: string }, section: string) => { instruction: string; title: string; body: string };
  createExamHtml: (input: Record<string, unknown>) => string;
  findQuoteOffset: (source: string, start: number, quote: string) => number;
  findEvidenceMatch: (source: string, evidence: string) => { start: number; end: number; exact: boolean; score: number } | null;
  renderTranscriptHtml: (data: Record<string, unknown>, options?: Record<string, unknown>) => {
    html: string;
    matches: Array<{ questionId: string; number: number; ranges: Array<{ start: number; end: number; exact: boolean }>; kinds: string[] }>;
  };
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

  it("shows the transcript only after a result exists", () => {
    const activity = {
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
      responses: [{
        questionId: "q1",
        correct: false,
        independent: true,
        selected: "B",
        correctAnswer: "A",
        evidence: "Evidence.",
        explanation: "Explanation.",
        skillTags: ["listening.detail"],
        materialId: activity.id,
      }],
      sample: false,
    };
    const after = examUi.createExamHtml({ activity, draft, result, section: "listening" });
    assert.equal(after.includes("data-transcript-toggle"), true);
    assert.equal(after.includes('data-locate-answer="q1"'), true);
    assert.equal(after.includes("data-transcript-answers"), true);
    assert.equal(after.includes("data-transcript-answer-nav"), true);
  });

  it("locates an answer sentence across case, punctuation and line breaks", () => {
    const transcript = "Narrator: Welcome.\nMan: It will take place on\nSaturday morning at the glasshouse.";
    const match = examUi.findEvidenceMatch(transcript, "it will take place on saturday morning");
    assert.ok(match);
    assert.equal(match.exact, true);
    assert.equal(transcript.slice(match.start, match.end), "It will take place on\nSaturday morning");
  });

  it("falls back to a fuzzy sentence match when the evidence is paraphrased", () => {
    const transcript = "Woman: We expect the session to last about one and a half hours.";
    const match = examUi.findEvidenceMatch(transcript, "We expect the session to last around one and a half hours.");
    assert.ok(match);
    assert.equal(match.exact, false);
    assert.match(transcript.slice(match.start, match.end), /^We expect the session to last about one and a half hours\.$/);
  });

  it("rejects very short evidence that appears more than once", () => {
    assert.equal(examUi.findEvidenceMatch("Saturday and Saturday again", "Saturday"), null);
    assert.ok(examUi.findEvidenceMatch("Meet on Saturday morning", "Saturday"));
    assert.equal(examUi.findEvidenceMatch("Nothing related here.", "A completely different sentence."), null);
  });

  it("renders answer sentences as numbered marks in the transcript", () => {
    const view = examUi.renderTranscriptHtml(
      { transcript: "Intro. It will take place on Saturday morning. End." },
      { answerSentences: [{ questionId: "q2", number: 2, evidence: "It will take place on Saturday morning.", state: "wrong" }] },
    );
    assert.equal(view.matches.length, 1);
    assert.equal(view.matches[0]?.questionId, "q2");
    assert.match(view.html, /<mark class="exam-transcript-answer"[^>]*data-answer-question="q2"[^>]*>It will take place on Saturday morning\.<\/mark>/);
    assert.match(view.html, /data-answer-state="wrong"/);
    assert.match(view.html, /<span class="exam-transcript-answer-tag"[^>]*>2<\/span>/);
  });

  it("merges overlapping answer sentences and keeps both question numbers", () => {
    const view = examUi.renderTranscriptHtml(
      { transcript: "It will take place on Saturday morning." },
      {
        answerSentences: [
          { questionId: "q1", number: 1, evidence: "It will take place on Saturday morning.", state: "wrong" },
          { questionId: "q2", number: 2, evidence: "It will take place on Saturday morning.", state: "correct" },
        ],
      },
    );
    assert.equal(view.matches.length, 2);
    assert.match(view.html, /data-answer-question="q1 q2"/);
    assert.match(view.html, /data-answer-number="1·2"/);
    assert.equal((view.html.match(/class="exam-transcript-answer-tag"/g) ?? []).length, 1);
  });
});
