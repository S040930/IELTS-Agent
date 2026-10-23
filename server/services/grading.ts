import type { Activity, QuestionResult } from "../../src/shared/domain.js";

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function gradeActivity(activity: Activity, answers: Record<string, string>, hintedQuestionIds: string[]): QuestionResult[] {
  const groupResults = new Map<string, boolean>();
  const groupedQuestions = new Map<string, typeof activity.questions>();
  for (const question of activity.questions) {
    if (!question.answerGroupId) continue;
    groupedQuestions.set(question.answerGroupId, [...(groupedQuestions.get(question.answerGroupId) ?? []), question]);
  }
  for (const [groupId, questions] of groupedQuestions) {
    const selected = questions.map((question) => normalize(answers[question.id])).filter(Boolean).sort();
    const expected = [...new Set(questions.flatMap((question) => question.answerGroupValues ?? [] ).map(normalize))].sort();
    groupResults.set(groupId, selected.length === expected.length && selected.every((value, index) => value === expected[index]));
  }
  return activity.questions.map((question) => {
    const selectedValue = answers[question.id] ?? "";
    const selected = question.optionLabels?.[selectedValue] ?? selectedValue;
    const hinted = hintedQuestionIds.includes(question.id);
    return {
      questionId: question.id,
      correct: question.answerGroupId
        ? groupResults.get(question.answerGroupId) ?? false
        : (question.acceptedAnswers ?? [question.correctAnswer]).some((answer) => normalize(selectedValue) === normalize(answer)),
      independent: !hinted,
      selected,
      correctAnswer: question.answerLabel ?? question.correctAnswer,
      evidence: question.evidence,
      explanation: question.explanation,
      skillTags: question.skillTags,
      materialId: activity.id,
    };
  });
}

