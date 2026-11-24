import type { SpeakingLine } from "../shared/speaking.js";

interface DemoScript {
  turns: Array<Pick<SpeakingLine, "role" | "text"> & { start: number; end: number }>;
  advice: string;
  revision: string;
}

// Timestamps are in seconds in the corresponding local, two-voice MP3.
export const demos = {
  "hometown": {
    turns: [
      { role: "examiner", start: 1.25, end: 3.795, text: "What do you like about your hometown?" },
      { role: "learner", start: 4.395, end: 8.37, text: "I like the river near my flat. I go there after class." },
      { role: "examiner", start: 8.97, end: 11.245, text: "What do you usually do by the river?" },
      { role: "learner", start: 11.845, end: 14.9, text: "I walk home along the water with my sister." },
    ],
    advice: "用一个细节解释你为什么喜欢河边。",
    revision: "After class, I often head down to the river near my flat.",
  },
  "studies": {
    turns: [
      { role: "examiner", start: 1.25, end: 3.295, text: "What are you studying at the moment?" },
      { role: "learner", start: 3.895, end: 8.73, text: "I study design. My favourite class is about how people read maps." },
      { role: "examiner", start: 9.33, end: 11.365, text: "What have you designed in that class?" },
      { role: "learner", start: 11.965, end: 16.355, text: "Last week I made a map to help new students find the library." },
    ],
    advice: "用具体作品展开回答，并说明它解决了什么问题。",
    revision: "I study design, and I especially enjoy learning how people read maps.",
  },
  "afternoons": {
    turns: [
      { role: "examiner", start: 1.25, end: 4.025, text: "What do you like doing on a free afternoon?" },
      { role: "learner", start: 4.625, end: 8.06, text: "On a free afternoon, I like cooking with my dad." },
      { role: "examiner", start: 8.66, end: 10.91, text: "What do you enjoy cooking together?" },
      { role: "learner", start: 11.51, end: 15.575, text: "We make noodles. He rolls out the dough while I cut the vegetables." },
    ],
    advice: "用分工的细节来展开一个日常活动。",
    revision: "When I have an afternoon off, I enjoy cooking with my dad.",
  },
  "quiet-place": {
    turns: [
      { role: "examiner", start: 1.25, end: 4.025, text: "Describe a quiet place you like to visit." },
      { role: "learner", start: 8.025, end: 18.19, text: "There is a small garden behind the library. I go there after class with a book. The trees keep it cool, and I can finish a chapter without checking my phone." },
    ],
    advice: "按地点、活动、感受组织陈述，再把地点与习惯连起来。",
    revision: "Behind the library there is a little garden where I read after class.",
  },
  "first-try": {
    turns: [
      { role: "examiner", start: 1.25, end: 4.125, text: "Describe a time you tried something new." },
      { role: "learner", start: 8.125, end: 17.355, text: "Last spring I went skating with my cousin for the first time. At first I held on to the wall. By the end, I could cross the rink on my own." },
    ],
    advice: "用开始和结束时的变化表现这次尝试的意义。",
    revision: "My cousin took me skating for the first time last spring.",
  },
  "gift": {
    turns: [
      { role: "examiner", start: 1.25, end: 3.865, text: "Describe a gift that meant a lot to you." },
      { role: "learner", start: 7.865, end: 18.445, text: "My grandmother gave me a wooden box on my birthday. She made it herself. I keep old train tickets in it because each one reminds me of a trip we took together." },
    ],
    advice: "说完礼物的样子后，用一个具体用途解释它为什么特别。",
    revision: "For my birthday, my grandmother gave me a wooden box she had made.",
  },
  "public-space": {
    turns: [
      { role: "examiner", start: 1.25, end: 6.665, text: "Some cities are turning car parks into public squares. How might this change life for residents?" },
      { role: "learner", start: 7.265, end: 12.225, text: "A square gives neighbours somewhere to meet, especially people who live alone." },
      { role: "examiner", start: 12.825, end: 15.185, text: "Who might find that change difficult?" },
      { role: "learner", start: 15.785, end: 21.815, text: "Shopkeepers might worry about deliveries, so the city could reserve a loading area nearby." },
    ],
    advice: "提出好处后，考虑另一群人的需求，让观点更完整。",
    revision: "A public square gives neighbours a place to meet, which is especially valuable for people living alone.",
  },
  "digital-books": {
    turns: [
      { role: "examiner", start: 1.25, end: 7.6, text: "Schools increasingly use digital textbooks. How does technology change the way people learn?" },
      { role: "learner", start: 8.2, end: 13.725, text: "Digital books make diagrams easier to explore because students can zoom in." },
      { role: "examiner", start: 14.325, end: 16.695, text: "Would every student benefit equally?" },
      { role: "learner", start: 17.295, end: 22.42, text: "Probably not. Families who share one device may still prefer printed books." },
    ],
    advice: "说明技术优势后，用一个反例界定它适用的条件。",
    revision: "With digital textbooks, students can zoom in and explore diagrams in more detail.",
  },
  "festivals": {
    turns: [
      { role: "examiner", start: 1.25, end: 7.57, text: "Some local festivals now attract international visitors. What effect can tourism have on traditions?" },
      { role: "learner", start: 8.17, end: 15.09, text: "Visitors can help pay for a festival, but the organisers may change the programme to suit tourists." },
      { role: "examiner", start: 15.69, end: 18.92, text: "How could local people keep a say in the programme?" },
      { role: "learner", start: 19.52, end: 24.915, text: "They could choose the main events themselves and invite visitors to join afterwards." },
    ],
    advice: "把旅游收入和居民选择权放在同一个具体例子里讨论。",
    revision: "Tourism can fund a festival, although organisers may adapt the programme to appeal to visitors.",
  },
} satisfies Record<string, DemoScript>;

export type DemoId = keyof typeof demos;
