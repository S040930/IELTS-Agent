const activity = {
  id: "sample-reading-green-spaces",
  pluginId: "reading",
  title: "Urban green spaces",
  description: "短篇示例 · 判断题 · 城市与健康",
  minutes: 12,
  difficulty: 2,
  sample: true,
  passage: {
    title: "Urban green spaces",
    text: `A\tCities around the world are increasingly investing in green spaces, such as parks, gardens and tree-lined streets. These areas provide a range of benefits, including cleaner air, cooler temperatures and opportunities for recreation. They can also help to make urban environments more attractive, which may encourage people to live, work and visit these areas.\n\nB\tResearch has shown that green spaces can contribute to better physical and mental health. People who spend time in natural environments often report lower levels of stress and higher levels of life satisfaction. In addition, being in green spaces may encourage more physical activity, such as walking or cycling, which can reduce the risk of some chronic diseases.\n\nC\tHowever, the benefits of urban green spaces are not the same in every location. The size, quality and accessibility of these areas can all influence their impact. For example, a large, well-maintained park may offer more environmental and social benefits than a small green area. In some cities, certain communities have limited access to green spaces, which can lead to inequalities in health and wellbeing.`,
  },
  questions: [
    { id: "read-q1", prompt: "All urban parks provide the same benefits.", kind: "tfng", options: ["TRUE", "FALSE", "NOT GIVEN"], skillTags: ["reading.paraphrase", "reading.tfng"], correctAnswer: "FALSE", evidence: "The benefits of urban green spaces are not the same in every location.", explanation: "文章直接说明不同地点的绿地并不提供完全相同的益处。" },
    { id: "read-q2", prompt: "Spending time in natural environments can support mental health.", kind: "tfng", options: ["TRUE", "FALSE", "NOT GIVEN"], skillTags: ["reading.paraphrase", "reading.tfng"], correctAnswer: "TRUE", evidence: "Research has shown that green spaces can contribute to better physical and mental health.", explanation: "题干的 support mental health 对应原文 contribute to better mental health，属于同义改写。" },
    { id: "read-q3", prompt: "Most city parks have sports facilities.", kind: "tfng", options: ["TRUE", "FALSE", "NOT GIVEN"], skillTags: ["reading.tfng", "reading.locating"], correctAnswer: "NOT GIVEN", evidence: "The passage describes the possible benefits of green spaces but does not say how many parks have sports facilities.", explanation: "全文没有提供城市公园中运动设施的数量或比例。信息缺失应选 NOT GIVEN。" },
    { id: "read-q4", prompt: "A small green space always provides more benefits than a large park.", kind: "tfng", options: ["TRUE", "FALSE", "NOT GIVEN"], skillTags: ["reading.tfng", "reading.qualifiers"], correctAnswer: "FALSE", evidence: "For example, a large, well-maintained park may offer more environmental and social benefits than a small green area.", explanation: "题干中的 always 表示绝对情况，原文举出大型公园可能提供更多益处，方向相反。" },
    { id: "read-q5", prompt: "Unequal access to green spaces can be connected with differences in health.", kind: "tfng", options: ["TRUE", "FALSE", "NOT GIVEN"], skillTags: ["reading.paraphrase", "reading.tfng"], correctAnswer: "TRUE", evidence: "limited access to green spaces, which can lead to inequalities in health and wellbeing.", explanation: "题干的 differences in health 对应原文 inequalities in health。" },
  ],
};

const skillTags = {
  "reading.tfng": "判断题：TRUE / FALSE / NOT GIVEN",
  "reading.paraphrase": "识别同义改写",
  "reading.locating": "定位相关信息",
  "reading.qualifiers": "识别范围与限定词",
};

export function activate(host) {
  host.registerActivity(activity);
  host.registerGrader((registeredActivity, answers, hints) => registeredActivity.questions.map((question) => ({
    questionId: question.id,
    correct: (answers[question.id] ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en") === question.correctAnswer.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en"),
    independent: !hints.includes(question.id), selected: answers[question.id] ?? "", correctAnswer: question.correctAnswer,
    evidence: question.evidence, explanation: question.explanation, skillTags: question.skillTags, materialId: registeredActivity.id,
  })));
  host.registerSkillTags(skillTags);
  host.registerCoachTool("reading-evidence", "找到并解释阅读题对应的文章证据", (snapshot) =>
    `当前题目：${snapshot.question.prompt}\n建议先定位题干中的关键词 ${snapshot.question.skillTags.join("、")}，再比较文章中的表达和题干的范围。一次练习的结果可以作为线索，确认原因需要更多新题证据。`,
  );
  host.registerHintStrategy((question) => `我们先找题干里有辨识度的词：「${question.prompt.split(/\s+/).slice(0, 5).join(" ")}」。在文章里找到相关段落后，比较句子说的是同一件事、相反的事，还是文章没有提到。`);
}

