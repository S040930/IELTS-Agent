import { createExamHtml, mountExamBehavior } from "/plugin-assets/shared/exam-ui.mjs";

export function mountPractice(root, { activity, draft, result, onAnswer, onSubmit, onCurrentQuestion, onAudioInterrupted, skillLabels, now } = {}) {
  const answers = { ...(draft?.answers ?? {}) };
  const selectedQuestionIds = draft?.questionIds?.length ? draft.questionIds : draft?.mode === "review" ? draft.reviewQuestionIds : undefined;
  const visibleQuestions = selectedQuestionIds?.length
    ? activity.questions.filter((question) => selectedQuestionIds.includes(question.id))
    : activity.questions;
  const view = { ...activity, questions: visibleQuestions };
  root.innerHTML = createExamHtml({ activity: view, draft, result, section: "listening", skillLabels });
  const cleanup = mountExamBehavior(root, {
    activity: view,
    draft,
    now,
    answers,
    onAnswer,
    onSubmit,
    onCurrentQuestion,
    onAudioInterrupted,
    attemptId: draft?.attemptId ?? "",
    hasResult: Boolean(result),
  });
  return () => { cleanup(); root.replaceChildren(); };
}
