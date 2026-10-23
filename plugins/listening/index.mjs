const activity = {
  id: "sample-listening-community-garden",
  pluginId: "listening",
  title: "Community garden workshop",
  description: "短篇示例 · 关键信息与细节",
  minutes: 8,
  difficulty: 1,
  sample: true,
  audioUrl: "/assets/garden-workshop.wav",
  transcript: "Hello, I'm calling about the weekend composting workshop at Brookfield Community Garden. It will take place on Saturday morning. We will meet at the entrance to the glasshouse at half past nine. Please bring your own gloves, because we have a limited supply. The workshop is free for members and visitors. There is no need to book in advance, but please arrive ten minutes early so we can start on time. The garden is next to the library, and the nearest bus stop is called Brookfield Lane. We expect the session to last about one and a half hours.",
  questions: [
    { id: "listen-q1", prompt: "What is the caller asking about?", kind: "choice", options: ["A composting workshop", "A new library", "A bus timetable"], skillTags: ["listening.locating", "listening.paraphrase"], correctAnswer: "A composting workshop", evidence: "the weekend composting workshop at Brookfield Community Garden", explanation: "用 caller 的目的定位录音开头。" },
    { id: "listen-q2", prompt: "On which day will the workshop take place?", kind: "choice", options: ["Friday", "Saturday", "Sunday"], skillTags: ["listening.detail", "listening.time"], correctAnswer: "Saturday", evidence: "It will take place on Saturday morning.", explanation: "日期出现后，留意后续的场地和时间。" },
    { id: "listen-q3", prompt: "Where should visitors meet?", kind: "choice", options: ["The library entrance", "The glasshouse entrance", "The bus stop"], skillTags: ["listening.detail", "listening.location"], correctAnswer: "The glasshouse entrance", evidence: "We will meet at the entrance to the glasshouse.", explanation: "这里考场地信息。录音提到 library 与 bus stop 是其他地点，不是集合点。" },
    { id: "listen-q4", prompt: "What should visitors bring?", kind: "choice", options: ["A notebook", "A warm coat", "Their own gloves"], skillTags: ["listening.detail", "listening.paraphrase"], correctAnswer: "Their own gloves", evidence: "Please bring your own gloves, because we have a limited supply.", explanation: "关注需要自带物品的表达 bring your own gloves。" },
    { id: "listen-q5", prompt: "How long should the session last?", kind: "choice", options: ["About one hour", "About one and a half hours", "About two hours"], skillTags: ["listening.detail", "listening.number"], correctAnswer: "About one and a half hours", evidence: "We expect the session to last about one and a half hours.", explanation: "留意数字及其前后的单位。" },
  ],
};

const skillTags = {
  "listening.locating": "听力信息定位",
  "listening.paraphrase": "听辨同义替换",
  "listening.detail": "听取具体细节",
  "listening.time": "听取日期与时间",
  "listening.location": "听取地点",
  "listening.number": "听取数字与数量",
};

export function activate(host) {
  host.registerActivity(activity);
  const normalize = (value) => (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  host.registerGrader((registeredActivity, answers, hints) => {
    const groups = new Map();
    for (const question of registeredActivity.questions) if (question.answerGroupId) groups.set(question.answerGroupId, [...(groups.get(question.answerGroupId) ?? []), question]);
    const groupResults = new Map([...groups].map(([id, questions]) => {
      const selected = questions.map((question) => normalize(answers[question.id])).filter(Boolean).sort();
      const expected = [...new Set(questions.flatMap((question) => question.answerGroupValues ?? []).map(normalize))].sort();
      return [id, selected.length === expected.length && selected.every((value, index) => value === expected[index])];
    }));
    return registeredActivity.questions.map((question) => {
      const selectedValue = answers[question.id] ?? "";
      return {
        questionId: question.id,
        correct: question.answerGroupId ? groupResults.get(question.answerGroupId) ?? false : (question.acceptedAnswers ?? [question.correctAnswer]).some((answer) => normalize(selectedValue) === normalize(answer)),
        independent: !hints.includes(question.id), selected: question.optionLabels?.[selectedValue] ?? selectedValue, correctAnswer: question.answerLabel ?? question.correctAnswer,
        evidence: question.evidence, explanation: question.explanation, skillTags: question.skillTags, materialId: registeredActivity.id,
      };
    });
  });
  host.registerSkillTags(skillTags);
  host.registerCoachTool("listening-cue", "解释听力题中的关键词和信号词", (snapshot) =>
    `当前题目：${snapshot.question.prompt}\n先听题干中的关键词 ${snapshot.question.skillTags.join("、")}，留意录音里含义相同、表达不同的词组；如需再听，可暂停后回到对应位置。`,
  );
  host.registerHintStrategy((question) => `我们先判断这道题要听哪一类内容：「${question.prompt.slice(0, 70)}」。再听一遍时，可以暂停在出现这个话题的位置，留意日期、地点、数字或改说法的信号词。先自己选择，答案会在提交后一起复盘。`);
}

