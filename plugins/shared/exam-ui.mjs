/* 雅思机考（CD IELTS）共享渲染与行为模块：阅读 / 听力插件共用。纯 ESM，无依赖。 */
import { mountMockAudio } from "./mock-audio.mjs";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const text = (value = "") => String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);

export function findQuoteOffset(source, start, quote) {
  const content = String(source ?? "");
  const needle = String(quote ?? "").trim();
  if (!needle) return -1;
  const preferred = Math.max(0, Math.min(Number(start) || 0, content.length));
  if (content.slice(preferred, preferred + needle.length).trim() === needle) return preferred;
  let best = -1;
  let index = content.indexOf(needle);
  while (index !== -1) {
    if (best === -1 || Math.abs(index - preferred) < Math.abs(best - preferred)) best = index;
    index = content.indexOf(needle, index + 1);
  }
  return best;
}

function scrollParent(node) {
  let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (element && element !== document.body && element !== document.documentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && element.scrollHeight > element.clientHeight) return element;
    element = element.parentElement;
  }
  return null;
}

const cssEscape = (value) => (globalThis.CSS && typeof globalThis.CSS.escape === "function" ? globalThis.CSS.escape(value) : String(value).replace(/["\\].#:[]/g, "\\$&"));
const BLANK_PATTERN = /_{2,}/g;
const HAS_BLANK = /_{2,}/;
const CONTEXT_NUMBERED_BLANK = /(\d+)\s*[.)]?\s*(?:[a-z]\.?\s*)?[£$]?\s*(_{2,})/;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const WORD_NUMBERS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };
const WORD_NUMBER_PATTERN = "one|two|three|four|five|six|seven|eight|nine|ten|\\d+";
const WORD_NUMBER_UPPER = "ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|\\d+";
const WORD_LIMIT_PATTERNS = [
  new RegExp(`no\\s+more\\s+than\\s+(${WORD_NUMBER_PATTERN})\\s+words?\\b`, "i"),
  new RegExp(`(${WORD_NUMBER_PATTERN})\\s+words?\\s+and\\/?or\\s+a\\s+number`, "i"),
  new RegExp(`(${WORD_NUMBER_PATTERN})\\s+words?\\s+only`, "i"),
  /\b(one)\s+year\b/i,
];
const LIMIT_BOLD_PATTERN = new RegExp(
  `((?:NO\\s+MORE\\s+THAN\\s+(?:${WORD_NUMBER_UPPER})\\s+WORDS?(?:\\s+AND\\/?OR\\s+A\\s+NUMBER)?)|\\bONE\\s+WORDS?\\s+ONLY\\b|\\bONE\\s+WORDS?\\s+AND\\/?OR\\s+A\\s+NUMBER\\b|\\bONE\\s+YEAR\\b)`,
  "i",
);

export function letterOf(label) {
  const raw = String(label ?? "").trim();
  const match = /^([A-Za-z])\s*[.)]\s*(.*)$/.exec(raw);
  if (match) return { letter: String(match[1]).toUpperCase(), text: String(match[2] ?? "").trim() };
  if (/^[A-Za-z]$/.test(raw)) return { letter: raw.toUpperCase(), text: raw };
  return { letter: "", text: raw };
}

export function parseWordLimit(value) {
  const source = String(value ?? "");
  if (!source) return null;
  for (const pattern of WORD_LIMIT_PATTERNS) {
    const match = pattern.exec(source);
    if (!match) continue;
    const raw = (match[1] ?? "1").toLowerCase();
    const maxWords = /^\d+$/.test(raw) ? Number(raw) : (WORD_NUMBERS[raw.toUpperCase()] ?? 1);
    const allowNumber = /and\s*\/?\s*or\s+a\s+number/i.test(source) || /\byear\b/i.test(match[0]);
    return { maxWords, allowNumber };
  }
  return null;
}

export function emphasizeInstruction(instruction) {
  return text(instruction).replace(LIMIT_BOLD_PATTERN, (match) => `<strong>${match}</strong>`);
}

export function splitPrompt(question, section) {
  const lines = String(question?.prompt ?? "").split("\n");
  if (section !== "reading") return { instruction: "", title: "", body: lines.join("\n") };
  const instruction = lines[0] ?? "";
  const rest = lines.slice(1);
  if (rest.length >= 2) {
    const first = rest[0].trim();
    if (first.length <= 90 && !/[.。;:]/.test(first) && !HAS_BLANK.test(first)) return { instruction, title: first, body: rest.slice(1).join("\n") };
  }
  return { instruction, title: "", body: rest.join("\n") };
}

function stripLeadingNumber(prompt, displayNumber) {
  const escaped = String(displayNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(prompt)
    .replace(new RegExp(`^\\s*${escaped}\\s*[.)]\\s*`), "")
    .replace(new RegExp(`(^|[^\\d])${escaped}\\s*[.)]?\\s*(?=_{2,})`), "$1")
    .trim();
}

function skillTag(question) { return question?.skillTags?.[0] ?? ""; }

function controlVariant(question) {
  const tag = skillTag(question);
  if (question?.kind === "completion") return "completion";
  if (/true-false-not-given|yes-no-not-given/.test(tag) || question?.kind === "tfng") return "tfng";
  if (question?.answerGroupId) return "slot-group";
  if (tag === "reading.matching-headings") return "shared-list";
  if (tag === "reading.matching-information") return "paragraph-strip";
  if (/^reading\.(matching-features|classification|matching-sentence-endings)$/.test(tag)) return "letter-strip";
  if (tag === "listening.matching") return "shared-list";
  return "choice";
}

function isMatrixGroup(question, section) {
  return section === "reading" && ["reading.matching-information", "reading.matching-features"].includes(skillTag(question));
}

const SHARED_LIST_VARIANTS = new Set(["shared-list", "letter-strip", "paragraph-strip", "slot-group"]);

function questionEntries(question) {
  const labels = question?.optionLabels ?? {};
  const options = question?.options ?? [];
  return options.map((option, index) => {
    const label = String(labels[option] ?? option);
    const parsed = letterOf(label);
    const letter = parsed.letter || LETTERS[index] || "";
    const body = parsed.text && parsed.text !== letter ? parsed.text : "";
    return { option, letter, label: body || label, hasText: Boolean(body) };
  });
}

function normalizeFeedbackAnswer(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function normalizedChoiceLabel(value) {
  return normalizeFeedbackAnswer(value).replace(/^[a-z]\s*[.)]\s*/, "");
}

function feedbackOption(question, response) {
  if (!response) return undefined;
  const expected = normalizeFeedbackAnswer(response.correctAnswer);
  const expectedLabel = normalizedChoiceLabel(response.correctAnswer);
  return questionEntries(question).find((entry) => {
    const labels = [entry.option, entry.letter, entry.label, question.optionLabels?.[entry.option]];
    return labels.some((label) => {
      const normalized = normalizeFeedbackAnswer(label);
      return normalized === expected || normalizedChoiceLabel(label) === expectedLabel;
    });
  });
}

function optionFeedbackClass(question, entry, ctx) {
  const response = ctx.resultByQuestion?.get(question.id);
  if (!response) return "";
  const selected = String(ctx.answers?.[question.id] ?? "");
  const expected = feedbackOption(question, response);
  if (expected?.option === entry.option) return " is-answer-correct";
  if (selected === entry.option) return response.correct ? " is-answer-correct" : " is-answer-wrong";
  return "";
}

function feedbackMarkup(question, ctx, section) {
  const response = ctx.resultByQuestion?.get(question.id);
  if (!response) return "";
  const selected = String(ctx.answers?.[question.id] ?? "").trim();
  const expected = feedbackOption(question, response);
  const itemCorrect = response.correct || (question.answerGroupId && selected && expected?.option === selected);
  const status = itemCorrect
    ? (response.correct ? "正确" : "本题答案正确，题组未全对")
    : selected ? "错误" : "未作答";
  const statusClass = itemCorrect ? "is-correct" : selected ? "is-wrong" : "is-unanswered";
  const answer = !itemCorrect || !selected
    ? `<span class="exam-feedback-answer">正确答案：${text(displayAnswer(question, response.correctAnswer))}</span>`
    : "";
  const number = question.displayNumber ?? "";
  const evidenceLabel = section === "listening" ? "录音内容" : "文章证据";
  const summary = `<div class="exam-q-feedback ${statusClass}" role="status"><span>${text(status)}</span>${answer}</div>`;
  const explanation = `<details class="exam-q-explanation"><summary>第 ${text(number)} 题 · 查看证据与解析</summary>`
    + `<p><strong>${text(evidenceLabel)}：</strong>${text(response.evidence || "（无）")}</p>`
    + `<p><strong>解析：</strong>${text(response.explanation || "（无）")}</p></details>`;
  return summary + explanation;
}

function feedbackStateClass(question, ctx) {
  const response = ctx.resultByQuestion?.get(question.id);
  if (!response) return "";
  const selected = String(ctx.answers?.[question.id] ?? "").trim();
  const expected = feedbackOption(question, response);
  const itemCorrect = response.correct || (question.answerGroupId && selected && expected?.option === selected);
  return itemCorrect ? " is-correct" : selected ? " is-wrong" : " is-unanswered";
}

function groupSignature(question) { return (question?.options ?? []).join("|"); }

export function groupQuestions(questions, section) {
  const groups = [];
  for (const question of questions) {
    const parsed = splitPrompt(question, section);
    const last = groups[groups.length - 1];
    let join = false;
    if (last) {
      if (section === "reading") {
        const previous = last.questions[last.questions.length - 1];
        const sharedNow = SHARED_LIST_VARIANTS.has(controlVariant(question));
        const sharedBefore = SHARED_LIST_VARIANTS.has(controlVariant(previous));
        join = last.instruction === parsed.instruction
          && last.title === parsed.title
          && !(sharedNow && sharedBefore && groupSignature(question) !== last.signature);
      } else {
        join = question.groupId === last.groupId;
      }
    }
    if (join && last) {
      last.questions.push(question);
      if (!last.title && parsed.title) last.title = parsed.title;
      if (section === "listening") {
        last.groupTitle = last.groupTitle ?? question.groupTitle;
        last.groupInstruction = last.groupInstruction ?? question.groupInstruction;
        last.groupContext = last.groupContext ?? question.groupContext;
      }
      continue;
    }
    groups.push({
      groupId: question.groupId,
      groupTitle: question.groupTitle,
      groupInstruction: question.groupInstruction,
      groupContext: question.groupContext,
      instruction: section === "reading" ? parsed.instruction : (question.groupInstruction ?? ""),
      title: parsed.title,
      signature: groupSignature(question),
      questions: [question],
    });
  }
  return groups;
}

function rangeLabel(questions, fallbackTitle) {
  const first = questions[0]?.displayNumber ?? 1;
  const last = questions[questions.length - 1]?.displayNumber ?? first;
  if (fallbackTitle) return String(fallbackTitle).replace(/[.\s]+$/, "");
  return first === last ? `Question ${first}` : `Questions ${first}–${last}`;
}

function listBlock(group) {
  const carrier = group.questions.find((question) => question.options?.length);
  if (!carrier) return "";
  const entries = questionEntries(carrier);
  if (!entries.length) return "";
  const hasText = entries.some((entry) => entry.hasText);
  const variant = controlVariant(carrier);
  const title = group.title || (variant === "slot-group" ? "Options" : "List of Answers");
  if (!hasText) {
    // 段落题（paragraph-strip）的选项本来就只有段落字母，属于正常考法，无需提示。
    const note = variant === "paragraph-strip" ? "" : `<p class="exam-listbox-note">列表项仅显示字母（源数据缺少完整列表文本）。</p>`;
    return `<div class="exam-listbox exam-listbox-letters"><div class="exam-listbox-title">${text(title)}</div>`
      + `<div class="exam-letters">${entries.map((entry) => `<span class="exam-letter-tag">${text(entry.letter)}</span>`).join("")}</div>`
      + `${note}</div>`;
  }
  return `<div class="exam-listbox"><div class="exam-listbox-title">${text(title)}</div><ol class="exam-listbox-items">`
    + entries.map((entry) => `<li><span class="exam-listbox-letter">${text(entry.letter)}</span><span>${text(entry.label)}</span></li>`).join("")
    + `</ol></div>`;
}

function blankMarkup(question, number, limit, ctx, showNumber = true) {
  const value = ctx.answers?.[question.id] ?? "";
  const response = ctx.resultByQuestion?.get(question.id);
  const state = response ? response.correct ? "correct" : value.trim() ? "wrong" : "unanswered" : "";
  const answerKey = state && state !== "correct" && response?.correctAnswer
    ? `<span class="exam-inline-answer-key">正确答案：${text(response.correctAnswer)}</span>`
    : "";
  const count = limit
    ? `<span class="exam-count" data-count-for="${text(question.id)}" hidden aria-hidden="true">0/${limit.maxWords}</span>`
    : "";
  const num = `<span class="exam-blank-num"${showNumber ? "" : " hidden aria-hidden=\"true\""}>${text(number)}</span>`;
  return `<span class="exam-blank${state ? ` is-${state}` : ""}" data-question="${text(question.id)}" id="q-${text(question.id)}">${num}`
    + `<input data-blank type="text" name="${text(question.id)}" value="${text(value)}" autocomplete="off" spellcheck="false" aria-label="Question ${text(number)} answer"${ctx.result ? " disabled" : ""}>`
    + `${count}${answerKey}</span>`;
}

function completionBody(body, questions, limit, ctx) {
  const parts = String(body).split(BLANK_PATTERN);
  if (parts.length === 1) return text(body).replace(/\n/g, "<br>");
  let html = "";
  for (let index = 0; index < parts.length; index += 1) {
    html += text(parts[index]).replace(/\n/g, "<br>");
    if (index >= parts.length - 1) continue;
    if (index < questions.length) {
      const question = questions[index];
      html += blankMarkup(question, question?.displayNumber ?? index + 1, limit, ctx);
    } else {
      html += `<span class="exam-blank is-static" aria-hidden="true">________</span>`;
    }
  }
  return html;
}

function tfngControl(question, ctx) {
  const entries = questionEntries(question);
  // 真机 CD IELTS：TRUE / FALSE / NOT GIVEN 竖排圆形单选
  return `<div class="exam-opts exam-opts-stack" role="radiogroup" aria-label="Choose an answer">`
    + entries.map((entry) => `<label class="exam-opt${optionFeedbackClass(question, entry, ctx)}"><input type="radio" name="${text(question.id)}" value="${text(entry.option)}" ${ctx.answers?.[question.id] === entry.option ? "checked" : ""}${ctx.result ? " disabled" : ""}><span class="exam-optbox" aria-hidden="true"></span><span class="exam-opttext">${text(entry.label)}</span></label>`).join("")
    + `</div>`;
}

function choiceControl(question, ctx) {
  const entries = questionEntries(question);
  return `<div class="exam-opts exam-opts-rows" role="radiogroup" aria-label="Choose an answer">`
    + entries.map((entry) => `<label class="exam-opt exam-opt-row${optionFeedbackClass(question, entry, ctx)}"><input type="radio" name="${text(question.id)}" value="${text(entry.option)}" ${ctx.answers?.[question.id] === entry.option ? "checked" : ""}${ctx.result ? " disabled" : ""}><span class="exam-optbox" aria-hidden="true"></span><span class="exam-optletter">${text(entry.letter)}</span><span class="exam-opttext">${text(entry.label)}</span></label>`).join("")
    + `</div>`;
}

function chipControl(question, ctx) {
  const entries = questionEntries(question);
  const group = question.answerGroupId ? ` data-answer-group="${text(question.answerGroupId)}"` : "";
  const described = entries.some((entry) => entry.hasText);
  return `<div class="exam-chips${described ? " exam-chips-described" : ""}" role="radiogroup" aria-label="Choose an answer"${group}>`
    + entries.map((entry) => `<label class="exam-chip${optionFeedbackClass(question, entry, ctx)}"><input type="radio" name="${text(question.id)}" value="${text(entry.option)}" data-letter="${text(entry.letter)}" ${ctx.answers?.[question.id] === entry.option ? "checked" : ""}${ctx.result ? " disabled" : ""}>`
      + `<span class="exam-chip-letter" aria-hidden="true">${text(entry.letter)}</span>`
      + (described && entry.hasText ? `<span class="exam-chip-text">${text(entry.label)}</span>` : "")
      + `</label>`).join("")
    + `</div>`;
}

function completionRuns(questions) {
  const runs = [];
  let index = 0;
  while (index < questions.length) {
    let next = index;
    while (next < questions.length && questions[next].prompt === questions[index].prompt) next += 1;
    runs.push({ questions: questions.slice(index, next) });
    index = next;
  }
  return runs;
}

function bodyOf(question, section) {
  const number = question.displayNumber ?? 1;
  const parsed = splitPrompt(question, section);
  return section === "reading" ? parsed.body : stripLeadingNumber(question.prompt, number);
}

function renderSingleQuestion(question, section, ctx, overrideBody) {
  const { wordLimit } = ctx;
  const variant = controlVariant(question);
  const number = question.displayNumber ?? 1;
  const rawBody = overrideBody ?? bodyOf(question, section);
  const bodyHtml = variant === "completion"
    ? completionBody(rawBody, [question], wordLimit, ctx)
    : text(rawBody).replace(/\n/g, "<br>");
  const control = variant === "tfng" ? tfngControl(question, ctx)
    : variant === "completion" ? ""
      : (variant === "slot-group" || variant === "shared-list" || variant === "letter-strip" || variant === "paragraph-strip")
        ? chipControl(question, ctx)
        : choiceControl(question, ctx);
  const flag = `<button type="button" class="exam-flag" data-flag="${text(question.id)}" aria-pressed="false" aria-label="Flag question ${text(number)} for review" title="Flag for review"${ctx.result ? " disabled" : ""}><svg viewBox="0 0 14 16" width="14" height="16" aria-hidden="true"><path d="M2 1.6h10v12.6L7 11.3 2 14.2V1.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>`;
  const answerGroup = question.answerGroupId ? ` data-answer-group="${text(question.answerGroupId)}"` : "";
  // 填空题的锚点由内部 blank 提供，避免 article 与 blank 重复 id
  const anchor = variant === "completion" ? "" : ` id="q-${text(question.id)}"`;
  return `<article class="exam-q${feedbackStateClass(question, ctx)}" data-question="${text(question.id)}"${anchor}${answerGroup}>`
    + `<div class="exam-q-head"><span class="exam-q-num">${text(number)}</span><div class="exam-q-text">${bodyHtml}</div>${flag}</div>`
    + `${control}${feedbackMarkup(question, ctx, section)}</article>`;
}

function renderMatchingMatrix(questions, ctx, allowRepeated, matchingFeatures = false) {
  const carrier = questions.find((question) => question.options?.length);
  if (!carrier) return questions.map((question) => renderSingleQuestion(question, "reading", ctx)).join("");
  const entries = questionEntries(carrier);
  const head = entries.map((entry) => `<th scope="col">${text(entry.letter)}</th>`).join("");
  const rows = questions.map((question) => {
    const number = question.displayNumber ?? 1;
    const body = text(bodyOf(question, "reading")).replace(/\n/g, "<br>");
    const flag = `<button type="button" class="exam-flag" data-flag="${text(question.id)}" aria-pressed="false" aria-label="Flag question ${text(number)} for review" title="Flag for review"${ctx.result ? " disabled" : ""}><svg viewBox="0 0 14 16" width="14" height="16" aria-hidden="true"><path d="M2 1.6h10v12.6L7 11.3 2 14.2V1.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>`;
    const response = ctx.resultByQuestion?.get(question.id);
    const expected = feedbackOption(question, response);
    const options = questionEntries(question).map((entry) => {
      const selected = ctx.answers?.[question.id] === entry.option;
      const answerClass = response && expected?.option === entry.option ? " is-answer-correct"
        : response && selected ? response.correct ? " is-answer-correct" : " is-answer-wrong"
          : "";
      return `<td><label class="exam-matrix-choice${answerClass}" aria-label="Question ${text(number)}, ${matchingFeatures ? "researcher" : "paragraph"} ${text(entry.letter)}${matchingFeatures && entry.label ? `, ${text(entry.label)}` : ""}"><input class="exam-matrix-radio" type="radio" name="${text(question.id)}" value="${text(entry.option)}" ${selected ? "checked" : ""}${ctx.result ? " disabled" : ""}></label></td>`;
    }).join("");
    const unique = allowRepeated ? "" : ` data-answer-group="${matchingFeatures ? "matching" : "paragraph"}-${text(questions[0]?.groupId ?? questions[0]?.id)}"`;
    const rowClass = feedbackStateClass(question, ctx);
    const details = response ? `<tr class="exam-matrix-feedback-row"><td colspan="${entries.length + 2}">${feedbackMarkup(question, ctx, "reading")}</td></tr>` : "";
    return `<tr class="exam-q exam-matrix-row${rowClass}" data-question="${text(question.id)}" id="q-${text(question.id)}"${unique}><th scope="row" class="exam-matrix-statement"><span class="exam-q-num">${text(number)}</span><span class="exam-matrix-copy">${body}</span></th>${options}<td class="exam-matrix-flag-cell">${flag}</td></tr>${details}`;
  }).join("");
  return `<div class="exam-matrix-scroll${matchingFeatures ? " exam-matrix-scroll-features" : ""}"><table class="exam-matrix" style="--exam-matrix-option-count:${entries.length}" aria-label="Matching answers"><thead><tr><th scope="col" class="exam-matrix-prompt" aria-label="Statement"></th>${head}<th class="exam-matrix-flag-head" aria-hidden="true"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderGroupQuestions(group, section, ctx) {
  if (isMatrixGroup(group.questions[0], section)) {
    return renderMatchingMatrix(group.questions, ctx, ctx.allowRepeated, skillTag(group.questions[0]) === "reading.matching-features");
  }
  if (controlVariant(group.questions[0]) !== "completion") {
    return group.questions.map((question) => renderSingleQuestion(question, section, ctx)).join("");
  }
  const out = [];
  for (const run of completionRuns(group.questions)) {
    const n = run.questions.length;
    const body = bodyOf(run.questions[0], section);
    const slots = (body.match(BLANK_PATTERN) ?? []).length;
    if (slots === n && n > 1) {
      out.push(`<article class="exam-q exam-q-shared"><div class="exam-q-sharedbody">${completionBody(body, run.questions, ctx.wordLimit, ctx)}</div>${run.questions.map((question) => feedbackMarkup(question, ctx, section)).join("")}</article>`);
      continue;
    }
    for (const question of run.questions) out.push(renderSingleQuestion(question, section, ctx, body));
  }
  return out.join("");
}

function renderNotesBlock(context, questions, limit, ctx, section) {
  const byNumber = new Map(questions.map((question) => [question.displayNumber, question]));
  const boundIds = new Set();
  const perLine = new Map();
  const lines = String(context).split("\n");
  lines.forEach((line, index) => {
    const match = CONTEXT_NUMBERED_BLANK.exec(line);
    if (!match) return;
    const question = byNumber.get(Number(match[1]));
    if (!question || boundIds.has(question.id)) return;
    boundIds.add(question.id);
    perLine.set(index, question);
  });
  if (!boundIds.size) return { html: "", boundIds };
  const body = lines.map((line, index) => {
    const question = perLine.get(index);
    if (!question) return text(line);
    let replaced = false;
    return text(line).replace(/_{2,}/g, (blank) => {
      if (replaced) return blank;
      replaced = true;
      return blankMarkup(question, question.displayNumber, limit, ctx, false);
    });
  }).join("\n");
  return {
    html: `<article class="exam-q exam-q-shared exam-q-notes"><div class="exam-notes exam-notes-native"><div class="exam-notes-body">${body}</div></div>${questions.filter((question) => boundIds.has(question.id)).map((question) => feedbackMarkup(question, ctx, section)).join("")}</article>`,
    boundIds,
  };
}

function renderListeningContext(context) {
  const lines = String(context).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `<div class="exam-listening-context">`
    + `<strong class="exam-listening-context-title">${text(lines[0])}</strong>`
    + lines.slice(1).map((line) => `<div class="exam-listening-context-line">${text(line)}</div>`).join("")
    + `</div>`;
}

function renderMatrixOptionList(group) {
  const carrier = group.questions.find((question) => question.options?.length);
  if (!carrier) return "";
  const entries = questionEntries(carrier);
  if (!entries.some((entry) => entry.hasText)) return "";
  const title = group.title || "List of Answers";
  return `<div class="exam-matrix-list"><div class="exam-matrix-list-title">${text(title)}</div><ul class="exam-matrix-list-items">`
    + entries.map((entry) => `<li><strong>${text(entry.letter)}</strong><span>${text(entry.label)}</span></li>`).join("")
    + `</ul></div>`;
}

function renderGroup(group, section, ctx) {
  const title = rangeLabel(group.questions, section === "listening" ? group.groupTitle : undefined);
  const instructionSource = section === "reading" ? group.instruction : (group.groupInstruction ?? group.instruction);
  const instruction = instructionSource ? `<p class="exam-group-inst">${emphasizeInstruction(instructionSource)}</p>` : "";
  const matrix = isMatrixGroup(group.questions[0], section);
  const matrixOptionList = skillTag(group.questions[0]) === "reading.matching-features" ? renderMatrixOptionList(group) : "";
  const list = SHARED_LIST_VARIANTS.has(controlVariant(group.questions[0])) && !matrix ? listBlock(group) : "";
  const wordLimit = parseWordLimit(instructionSource) ?? ctx.wordLimit;
  const context = String(group.groupContext ?? "");
  const completionQuestions = group.questions.filter((question) => controlVariant(question) === "completion");
  const notes = context ? renderNotesBlock(context, completionQuestions, wordLimit, ctx, section) : { html: "", boundIds: new Set() };
  const rest = group.questions.filter((question) => !notes.boundIds.has(question.id));
  const allowRepeated = /(?:may|can)\s+choose\s+[^.\n]*?more than once|more than once/i.test(instructionSource);
  const questionsHtml = rest.length ? renderGroupQuestions({ ...group, questions: rest }, section, { ...ctx, wordLimit, allowRepeated }) : "";
  const quiet = context && !notes.boundIds.size
    ? (section === "listening"
      ? renderListeningContext(context)
      : `<div class="exam-notes exam-notes-quiet"><span class="exam-notes-label">Notes</span><div class="exam-notes-body">${text(context)}</div></div>`)
    : "";
  const contents = `<header class="exam-group"><div class="exam-group-range">${text(title)}</div>${instruction}${list}</header>${quiet}${notes.html}${questionsHtml}${matrixOptionList}`;
  return section === "listening"
    ? `<section class="exam-listening-group" aria-label="${text(title)}">${contents}</section>`
    : contents;
}

function renderPalette(questions, partLabel, result, parts = [], section = "reading") {
  const responses = new Map((result?.responses ?? []).map((response) => [response.questionId, response]));
  const cells = questions.map((question) => {
    const number = question.displayNumber ?? 1;
    const response = responses.get(question.id);
    const state = response ? response.correct ? " is-correct" : String(result?.answers?.[question.id] ?? "").trim() ? " is-wrong" : " is-unanswered" : "";
    const status = response ? response.correct ? ", correct" : String(result?.answers?.[question.id] ?? "").trim() ? ", incorrect" : ", unanswered" : "";
    return `<button type="button" class="exam-cell${state}" data-jump="${text(question.id)}" data-cell="${text(question.id)}" aria-label="Go to question ${text(number)}${status}">${text(number)}</button>`;
  }).join("");
  const progress = result ? `Submitted · ${text(result.score ?? 0)} / ${text(result.total ?? questions.length)} correct` : `Answered 0 / ${text(questions.length)}`;
  return `<nav class="exam-palette" aria-label="Question navigation">`
    + (parts.length ? `<div class="exam-part-tabs" role="tablist" aria-label="Test parts">${parts.map((part, index) => `<button type="button" role="tab" data-part-tab="${part.part}" aria-selected="${index === 0}">${section === "reading" ? "Passage" : "Part"} ${part.part}</button>`).join("")}</div>` : `<span class="exam-palette-label">${text(partLabel)}</span>`)
    + `<div class="exam-palette-grid">${cells}</div>`
    + `<span class="exam-palette-progress" data-exam-progress>${progress}</span>`
    + `<button type="button" class="exam-submit${result ? " is-submitted" : ""}" data-submit aria-label="${result ? "Answers submitted" : "Review and submit"}" title="${result ? "Answers submitted" : "Review and submit"}"${result ? " disabled" : ""}><span aria-hidden="true">✓</span></button></nav>`;
}

function renderSubmissionSummary(result) {
  const total = Number(result?.total ?? result?.responses?.length ?? 0);
  const score = Number(result?.score ?? 0);
  const percent = total ? Math.round((score / total) * 100) : 0;
  return `<div class="exam-submission-summary" role="status"><strong>已提交</strong><span>答对 ${text(score)} / ${text(total)} 题</span><span>${percent}%</span></div>`;
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function audioSources(activity) {
  const list = activity?.audioSections?.length
    ? activity.audioSections.map((section) => ({ title: section.title, src: section.audioUrl }))
    : (activity?.audioUrl ? [{ title: activity.title, src: activity.audioUrl }] : []);
  return list.filter((item) => item.src);
}

function renderAudioBar(activity, draft, result) {
  const sources = audioSources(activity);
  if (!sources.length) return "";
  if (draft?.mode === "mock" && !result) {
    return `<div class="exam-audio-bar exam-mock-audio"><audio data-audio preload="auto"></audio>`
      + `<span class="exam-playback-status" data-playback-status role="status">Preparing recording…</span>`
      + `<button type="button" class="exam-audio-resume" data-audio-retry hidden>Resume audio</button>`
      + `<label class="exam-audio-vol">Volume <input type="range" min="0" max="1" step="0.05" value="1" data-audio-vol aria-label="Volume"></label></div>`;
  }
  const tabs = sources.length > 1
    ? `<div class="exam-audio-tabs" role="tablist">${sources.map((source, index) => `<button type="button" role="tab" class="exam-audio-tab${index === 0 ? " is-active" : ""}" data-audio-tab="${index}" data-audio-src="${text(source.src)}" aria-selected="${index === 0}">${text(source.title ?? `Audio ${index + 1}`)}</button>`).join("")}</div>`
    : "";
  return `<div class="exam-audio-bar" data-audio-bar>${tabs}`
    + `<audio data-audio preload="metadata" src="${text(sources[0].src)}"></audio>`
    + `<button type="button" class="exam-audio-toggle" data-audio-toggle aria-label="Play"><span data-audio-icon>▶</span></button>`
    + `<div class="exam-audio-track" data-audio-track role="slider" tabindex="0" aria-label="Playback progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-audio-fill></i></div>`
    + `<span class="exam-audio-time"><span data-audio-now>0:00</span> / <span data-audio-len>--:--</span></span>`
    + `<label class="exam-audio-vol"><span aria-hidden="true">🔊</span><input type="range" min="0" max="1" step="0.05" value="1" data-audio-vol aria-label="Volume"></label>`
    + `</div>`;
}

function renderAnnotationTools() {
  return `<div class="exam-selection-menu" data-selection-menu hidden role="toolbar" aria-label="Text annotation tools">`
    + `<button type="button" data-annotation-action="highlight">Highlight</button><button type="button" data-annotation-action="note">Add note</button></div>`
    + `<aside class="exam-note-panel" data-notes-panel hidden aria-label="Notes">`
    + `<header class="exam-note-panel-head"><div><strong>Notes</strong><span data-note-count>0</span></div><button type="button" data-notes-close aria-label="Close notes">×</button></header>`
    + `<p class="exam-note-storage">Notes and highlights are saved in this browser for this attempt.</p>`
    + `<div class="exam-note-empty" data-note-empty>Select text and choose Add note to create a note.</div><ol class="exam-note-list" data-note-list></ol></aside>`
    + `<div class="exam-note-composer" data-note-composer hidden role="dialog" aria-label="Add a note">`
    + `<p>Note on: <span data-note-selection></span></p><textarea data-note-input aria-label="Note text" placeholder="Write a note..."></textarea>`
    + `<div><button type="button" data-note-cancel>Cancel</button><button type="button" data-note-save>Save note</button></div></div>`
    + `<div class="exam-font-panel" data-font-panel hidden role="group" aria-label="Text size">`
    + `<span>Text size</span><button type="button" data-font-size="16">Small</button><button type="button" data-font-size="18">Medium</button><button type="button" data-font-size="20">Large</button></div>`;
}

function renderPassage(activity, section) {
  if (section !== "reading") return "";
  const passages = activity?.passages?.length ? activity.passages : [activity?.passage].filter(Boolean);
  if (!passages.length) return "";
  const questions = activity?.questions ?? [];
  const questionsText = questions.map((question) => String(question.prompt ?? "")).join("\n");
  const referencedLetters = questions.some((question) => question.skillTags?.includes("reading.matching-information"))
    || /paragraphs?\s+[A-Z]\s*[–-]\s*[A-Z]\b/i.test(questionsText);
  const html = passages.map((item, passageIndex) => {
    const paragraphs = String(item?.text ?? "").split(/\n{2,}/);
    const paragraphLabels = paragraphs.map((paragraph) => /^([A-Z])[.\s]\s*\S/.exec(paragraph)?.[1] ?? "");
    const hasSequentialLabels = paragraphs.every((_, index) => paragraphLabels[index] === LETTERS[index]);
    const assign = referencedLetters && !hasSequentialLabels;
    return `<section class="exam-passage-chunk" data-passage-id="${text(item.id ?? "single")}"${passages.length > 1 && passageIndex > 0 ? " hidden" : ""}>${item?.title ? `<h3 class="exam-passage-title">${text(item.title)}</h3>` : ""}<div class="exam-passage-copy">`
      + paragraphs.map((paragraph, index) => {
        const match = hasSequentialLabels ? /^([A-Z])[.\s]\s*([\s\S]+)$/.exec(paragraph) : null;
        const letter = match ? match[1] : (assign && index < LETTERS.length ? LETTERS[index] : "");
        const content = match ? match[2] : paragraph;
        return `<p class="exam-para${letter ? " has-letter" : ""}">${letter ? `<span class="exam-para-letter">${text(letter)}</span>` : ""}<span>${text(content)}</span></p>`;
      }).join("")
      + `</div></section>`;
  }).join("");
  // Part 信息已由顶部指令条承担，文章面板不再放头部
  return `<aside class="exam-passage" aria-label="Passage"><div class="exam-passage-scroll">${html}</div></aside>`;
}

function displayAnswer(question, value) {
  const raw = String(value ?? "");
  if (!raw) return "未作答";
  return question?.optionLabels?.[raw] ?? raw;
}

function renderReport({ activity, result, section, skillLabels }) {
  const responses = result.responses ?? [];
  const total = result.total || responses.length || 1;
  const score = result.score ?? 0;
  const percentValue = Math.round((score / total) * 100);
  const questionById = new Map((activity?.questions ?? []).map((question) => [question.id, question]));
  const unanswered = responses.filter((response) => !String(response.selected ?? "").trim()).length;
  const wrong = responses.filter((response) => !response.correct && String(response.selected ?? "").trim()).length;
  const hinted = responses.filter((response) => !response.independent).length;
  const usedSeconds = Object.values(result.questionTimeSeconds ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const modeLabel = result.mode === "mock" ? "完整模考" : result.mode === "review" ? "错题复习" : "专项练习";
  const sectionLabel = section === "listening" ? "Listening" : "Reading";
  const evidenceLabel = section === "listening" ? "录音内容" : "文章证据";
  const skillRows = new Map();
  for (const response of responses) {
    const tag = response.skillTags?.[0] ?? "general";
    const row = skillRows.get(tag) ?? { tag, correct: 0, total: 0 };
    row.total += 1;
    if (response.correct) row.correct += 1;
    skillRows.set(tag, row);
  }
  const rows = responses.map((response, index) => {
    const question = questionById.get(response.questionId);
    const number = question?.displayNumber ?? index + 1;
    const unansweredResponse = !String(response.selected ?? "").trim();
    const rowState = response.correct ? "is-correct" : unansweredResponse ? "is-unanswered" : "is-wrong";
    const mark = response.correct
      ? `<span class="exam-mark is-correct" aria-label="答对">✔</span>`
      : unansweredResponse
        ? `<span class="exam-mark is-unanswered" aria-label="未作答">—</span>`
        : `<span class="exam-mark is-wrong" aria-label="答错">✘</span>`;
    const detail = `<tr class="exam-detail-row"><td colspan="4"><details${response.correct ? "" : " open"}><summary>第 ${text(number)} 题${response.independent ? "" : " · 使用过提示"} · 展开证据与解析</summary>`
      + `<p><strong>${text(evidenceLabel)}：</strong>${text(response.evidence || "（无）")}</p>`
      + `<p><strong>解析：</strong>${text(response.explanation || "（无）")}</p></details></td></tr>`;
    return `<tr class="${rowState}"><td class="exam-td-num">${text(number)}</td><td>${text(displayAnswer(question, response.selected))}</td><td>${text(displayAnswer(question, response.correctAnswer))}</td><td>${mark}</td></tr>${detail}`;
  }).join("");
  return `<section class="exam-report" aria-label="练习报告">`
    + `<header class="exam-report-head"><div class="exam-report-id"><span class="exam-report-brand">IELTS Practice Report</span><span class="exam-report-meta">${text(sectionLabel)} · ${text(modeLabel)} · ${new Date().toLocaleDateString("zh-CN")}</span><span class="exam-report-title">${text(activity?.title ?? "")}</span></div>`
    + `<div class="exam-report-score"><strong>${text(score)}</strong><span>/ ${text(total)}</span><em>${percentValue}%</em></div></header>`
    + `<div class="exam-report-stats"><div class="exam-stat"><span>答对</span><strong>${text(score)}</strong></div>`
    + `<div class="exam-stat"><span>答错</span><strong>${text(wrong)}</strong></div>`
    + `<div class="exam-stat"><span>未作答</span><strong>${text(unanswered)}</strong></div>`
    + `<div class="exam-stat"><span>用过提示</span><strong>${text(hinted)}</strong></div>`
    + `<div class="exam-stat"><span>用时</span><strong>${text(formatClock(usedSeconds))}</strong></div></div>`
    + `<div class="exam-skills">${[...skillRows.values()].map((row) => {
      const label = skillLabels?.[row.tag] ?? row.tag;
      const ratio = row.total ? Math.round((row.correct / row.total) * 100) : 0;
      return `<div class="exam-skill-row"><span class="exam-skill-label">${text(label)}</span><span class="exam-skill-meter"><i style="width:${ratio}%"></i></span><span class="exam-skill-value">${text(row.correct)}/${text(row.total)}</span></div>`;
    }).join("")}</div>`
    + `<table class="exam-table"><thead><tr><th>题号</th><th>我的答案</th><th>参考答案</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<div class="exam-report-actions"><button type="button" class="button button-primary" data-submit>再练一次</button></div>`
    + `</section>`;
}

export function createExamHtml({ activity, draft, result, section = "reading", skillLabels } = {}) {
  const questions = activity?.questions ?? [];
  const hasResult = Boolean(result);
  const inlineResult = hasResult && (section === "reading" || section === "listening");
  const groups = groupQuestions(questions, section);
  const firstNumber = questions[0]?.displayNumber ?? 1;
  const lastNumber = questions[questions.length - 1]?.displayNumber ?? firstNumber;
  const range = questions.length ? (firstNumber === lastNumber ? `Question ${firstNumber}` : `Questions ${firstNumber}–${lastNumber}`) : "";
  const parts = activity?.examParts ?? [];
  const partLabel = parts.length ? `${section === "reading" ? "Passage" : "Part"} ${parts[0].part}` : activity?.part
    ? `Part ${text(activity.part)}`
    : (section === "reading" ? "Reading" : "Listening");
  const partInstruction = questions.length
    ? (section === "reading" ? `Read the passage and answer ${range}.` : `Listen to the recording and answer ${range}.`)
    : "";
  const passage = renderPassage(activity, section);
  // 真机风格：双栏上方一条 Part 指令条，右侧可展开文章
  const expandButton = passage
    ? `<button type="button" class="exam-part-expand" data-expand-passage aria-pressed="false" aria-label="Expand passage" title="Expand or collapse passage"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2 9.5 6.5M2 14l4.5-4.5"/></svg></button>`
    : "";
  const partStrip = `<div class="exam-part-strip"><div class="exam-part-copy">`
    + `<div class="exam-part-title" data-current-part>${text(partLabel)}</div>`
    + (partInstruction ? `<div class="exam-part-inst" data-part-instruction>${text(partInstruction)}</div>` : "")
    + `</div><div class="exam-part-right">${expandButton}</div></div>`;
  const showTranscript = section === "listening" && Boolean(result);
  const showStudyTools = !hasResult || inlineResult;
  const toolProxy = showStudyTools || showTranscript
    ? `<div class="exam-tools-proxy" hidden aria-hidden="true">${showStudyTools ? `<button type="button" data-notes-toggle aria-expanded="false">Notes</button><button type="button" data-font-toggle aria-expanded="false">Text size</button>` : ""}${showTranscript ? `<button type="button" data-transcript-toggle aria-expanded="false">Transcript</button>` : ""}</div>`
    : "";
  const audio = renderAudioBar(activity, draft, result);
  const questionCtx = { answers: draft?.answers ?? {}, wordLimit: null, result, resultByQuestion: new Map((result?.responses ?? []).map((response) => [response.questionId, response])) };
  const questionsHtml = parts.length
    ? parts.map((part, index) => `<div class="exam-part-questions" data-exam-part="${part.part}"${index ? " hidden" : ""}>${groupQuestions(questions.filter((question) => part.questionIds.includes(question.id)), section).map((group) => renderGroup(group, section, questionCtx)).join("")}</div>`).join("")
    : groups.map((group) => renderGroup(group, section, questionCtx)).join("");
  const transcriptPanel = showTranscript
    ? `<aside class="exam-transcript-panel" data-transcript-panel hidden aria-label="Listening transcript">`
      + `<header class="exam-transcript-head"><strong>Transcript &amp; analysis</strong><button type="button" data-transcript-close aria-label="Close transcript">×</button></header>`
      + `<div class="exam-transcript-toolbar" role="toolbar" aria-label="Transcript display options">`
      + `<button type="button" data-transcript-original aria-pressed="true">Original</button><button type="button" data-transcript-chinese aria-pressed="true">Chinese</button><button type="button" data-transcript-analysis aria-expanded="false">Analysis</button></div>`
      + `<div class="exam-transcript-content" data-transcript-content aria-live="polite"><p class="exam-transcript-status">Open Transcript to load the recording text.</p></div>`
      + `<section class="exam-transcript-analysis" data-transcript-analysis-panel hidden aria-label="Question explanations"><div class="exam-transcript-analysis-content" data-transcript-analysis-content></div></section></aside>`
    : "";
  const splitter = passage
    ? `<div class="exam-splitter" data-splitter role="separator" aria-orientation="vertical" aria-label="Drag to adjust column width" tabindex="0" title="Drag to resize; double-click to reset"></div>`
    : "";
  const groupNav = groups.length > 1
    ? `<div class="exam-group-nav"><button type="button" class="exam-group-btn is-prev" data-group-prev aria-label="Previous question group">←</button>`
    + `<button type="button" class="exam-group-btn is-next" data-group-next aria-label="Next question group">→</button></div>`
    : "";
  const main = hasResult && !inlineResult
    ? renderReport({ activity, result, section, skillLabels })
    : `<div class="exam-main" data-section="${text(section)}">`
      + `${inlineResult ? renderSubmissionSummary(result) : ""}`
      + `<div class="exam-split">${passage}${splitter}<section class="exam-questions" aria-label="Questions">${questionsHtml}</section>${transcriptPanel}</div>`
      + renderPalette(questions, partLabel, inlineResult ? result : undefined, parts, section)
      + groupNav
      + `</div>`;
  const reviewDialog = !result ? `<dialog class="exam-review-dialog" data-submit-dialog aria-labelledby="exam-review-title"><h2 id="exam-review-title">Check your answers</h2><p data-review-summary></p><div class="exam-review-legend">Select a question to return to it. Outlined questions are unanswered; flags mark questions for review.</div><div class="exam-review-grid" data-review-grid></div><div class="exam-review-actions"><button type="button" data-review-cancel>Return to test</button><button type="button" data-confirm-submit>Submit answers</button></div></dialog>` : "";
  return `<div class="exam-shell${inlineResult ? " has-result" : ""}" data-section="${text(section)}">${partStrip}${audio}${main}${toolProxy}${showStudyTools ? renderAnnotationTools() : ""}${reviewDialog}</div>`;
}

export function mountExamBehavior(root, ctx = {}) {
  const { answers = {}, onAnswer, onSubmit, onCurrentQuestion, onAudioInterrupted, attemptId = "", hasResult = false, activity = {}, draft = {}, now } = ctx;
  const cleanups = [];
  const add = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };
  const questionsContainer = root.querySelector(".exam-questions");
  const flagKey = attemptId ? `ielts-exam-flags-${attemptId}` : "";
  const flags = (() => {
    if (!flagKey) return new Set();
    try { return new Set(JSON.parse(localStorage.getItem(flagKey) ?? "[]")); } catch { return new Set(); }
  })();
  const writeFlags = () => {
    if (!flagKey) return;
    try { localStorage.setItem(flagKey, JSON.stringify([...flags])); } catch { /* storage unavailable */ }
  };

  const annotationKey = attemptId ? `ielts-exam-annotations-v1:${attemptId}` : "";
  const fontKey = "ielts-exam-font-size-v1";
  const annotations = (() => {
    if (!annotationKey) return { highlights: [], notes: [] };
    try {
      const stored = JSON.parse(localStorage.getItem(annotationKey) ?? "{}");
      return {
        highlights: Array.isArray(stored.highlights) ? stored.highlights : [],
        notes: Array.isArray(stored.notes) ? stored.notes : [],
      };
    } catch { return { highlights: [], notes: [] }; }
  })();
  const annotationPanel = root.querySelector("[data-notes-panel]");
  const annotationList = root.querySelector("[data-note-list]");
  const annotationEmpty = root.querySelector("[data-note-empty]");
  const annotationCount = root.querySelector("[data-note-count]");
  const selectionMenu = root.querySelector("[data-selection-menu]");
  const noteComposer = root.querySelector("[data-note-composer]");
  const noteInput = root.querySelector("[data-note-input]");
  const fontPanel = root.querySelector("[data-font-panel]");
  const transcriptToggle = root.querySelector("[data-transcript-toggle]");
  const transcriptPanel = root.querySelector("[data-transcript-panel]");
  const transcriptContent = root.querySelector("[data-transcript-content]");
  const transcriptAnalysisToggle = root.querySelector("[data-transcript-analysis]");
  const transcriptAnalysisPanel = root.querySelector("[data-transcript-analysis-panel]");
  const transcriptAnalysisContent = root.querySelector("[data-transcript-analysis-content]");
  let transcriptLoaded = false;
  let transcriptRequest = null;
  let analysisLoaded = false;
  let analysisRequest = null;
  let pendingSelection = null;

  const renderTranscript = (data) => {
    if (!transcriptContent) return;
    const sections = Array.isArray(data?.audioSections)
      ? data.audioSections.filter((item) => typeof item?.transcript === "string" && item.transcript.trim())
      : [];
    const sources = sections.length ? sections : (typeof data?.transcript === "string" && data.transcript.trim() ? [{ title: "", transcript: data.transcript }] : []);
    if (!sources.length) {
      transcriptContent.innerHTML = `<p class="exam-transcript-status">Transcript is not available for this recording yet.</p>`;
      transcriptLoaded = true;
      return;
    }
    const showOriginal = root.querySelector("[data-transcript-original]")?.getAttribute("aria-pressed") !== "false";
    const showChinese = root.querySelector("[data-transcript-chinese]")?.getAttribute("aria-pressed") !== "false";
    transcriptContent.innerHTML = sources.map((source, sectionIndex) => {
      const blocks = String(source.transcript).replace(/\r/g, "").trim().split(/\n\s*\n/).filter(Boolean);
      const cues = blocks.map((block) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        const timeIndex = lines.findIndex((line) => line.includes("-->"));
        const time = timeIndex >= 0 ? lines[timeIndex] : "";
        const body = lines.filter((_, index) => index !== timeIndex && !(timeIndex >= 0 && index < timeIndex));
        const original = [];
        const chinese = [];
        for (const line of body) {
          const translated = /^(?:中文|Chinese|Mandarin)\s*[:：]\s*/i.exec(line);
          if (translated) chinese.push(line.slice(translated[0].length));
          else original.push(line);
        }
        const renderLines = (items) => items.length ? `<p>${text(items.join("\n")).replace(/\n/g, "<br>")}</p>` : "";
        return `<article class="exam-transcript-cue" data-transcript-cue data-audio-section="${sectionIndex}">`
          + (time ? `<div class="exam-transcript-time">${text(time)}</div>` : "")
          + `<div class="exam-transcript-original" data-transcript-original-text${showOriginal ? "" : " hidden"}>${renderLines(original)}</div>`
          + `<div class="exam-transcript-chinese" data-transcript-chinese-text${showChinese ? "" : " hidden"}>${renderLines(chinese)}</div>`
          + `</article>`;
      }).join("");
      return `<section class="exam-transcript-section">${source.title ? `<h3>${text(source.title)}</h3>` : ""}${cues}</section>`;
    }).join("");
    transcriptLoaded = true;
  };
  const loadTranscript = async () => {
    if (!transcriptContent || !attemptId || transcriptLoaded || transcriptRequest) return transcriptRequest;
    transcriptContent.innerHTML = `<p class="exam-transcript-status">Loading transcript…</p>`;
    transcriptRequest = (async () => {
      try {
        const response = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/transcript`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not load transcript.");
        renderTranscript(data);
      } catch {
        transcriptContent.innerHTML = `<p class="exam-transcript-status">Could not load the transcript. <button type="button" data-transcript-retry>Try again</button></p>`;
      } finally {
        transcriptRequest = null;
      }
    })();
    return transcriptRequest;
  };
  const renderAnalysis = (data) => {
    if (!transcriptAnalysisContent) return;
    const explanations = Array.isArray(data?.explanations) ? data.explanations : [];
    transcriptAnalysisContent.innerHTML = explanations.length
      ? explanations.map((item) => `<article class="exam-transcript-explanation"><h4>Question ${text(item.displayNumber ?? "")}${item.answer ? ` · Answer: ${text(item.answer)}` : ""}</h4>${item.prompt ? `<p class="exam-transcript-question">${text(item.prompt)}</p>` : ""}${item.evidence ? `<p><strong>Evidence</strong><br>${text(item.evidence).replace(/\n/g, "<br>")}</p>` : ""}${item.explanation ? `<p><strong>Explanation</strong><br>${text(item.explanation).replace(/\n/g, "<br>")}</p>` : ""}</article>`).join("")
      : `<p class="exam-transcript-status">No explanations are available for this activity yet.</p>`;
    analysisLoaded = true;
  };
  const loadAnalysis = async () => {
    if (!transcriptAnalysisContent || !attemptId || analysisLoaded || analysisRequest) return analysisRequest;
    transcriptAnalysisContent.innerHTML = `<p class="exam-transcript-status">Loading explanations…</p>`;
    analysisRequest = (async () => {
      try {
        const response = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/analysis`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not load explanations.");
        renderAnalysis(data);
      } catch {
        transcriptAnalysisContent.innerHTML = `<p class="exam-transcript-status">Could not load explanations. <button type="button" data-transcript-analysis-retry>Try again</button></p>`;
      } finally {
        analysisRequest = null;
      }
    })();
    return analysisRequest;
  };

  const scopeElement = (scope) => scope === "passage"
    ? root.querySelector(".exam-passage-scroll")
    : scope === "questions" ? root.querySelector(".exam-questions") : null;
  const annotationScope = (node) => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element || !root.contains(element)) return "";
    if (element.closest(".exam-passage-scroll")) return "passage";
    if (element.closest(".exam-questions")) return "questions";
    return "";
  };
  const annotationTextNodes = (scope) => {
    const container = scopeElement(scope);
    if (!container) return [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent?.closest("button,input,textarea,select,svg,.exam-q-num,.exam-cell,.exam-audio-bar,.exam-note-panel,.exam-note-composer,.exam-selection-menu,.exam-font-panel")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  };
  const offsetForBoundary = (scope, container, offset) => {
    if (container?.nodeType !== Node.TEXT_NODE) return null;
    let total = 0;
    for (const node of annotationTextNodes(scope)) {
      if (node === container) return total + Math.max(0, Math.min(Number(offset) || 0, node.nodeValue?.length ?? 0));
      total += node.nodeValue?.length ?? 0;
    }
    return null;
  };
  const rangeForOffsets = (scope, start, end) => {
    const nodes = annotationTextNodes(scope);
    let total = 0;
    let startPoint = null;
    let endPoint = null;
    for (const node of nodes) {
      const length = node.nodeValue?.length ?? 0;
      if (!startPoint && start <= total + length) startPoint = { node, offset: Math.max(0, start - total) };
      if (end <= total + length) { endPoint = { node, offset: Math.max(0, end - total) }; break; }
      total += length;
    }
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    try { range.setStart(startPoint.node, startPoint.offset); range.setEnd(endPoint.node, endPoint.offset); return range; }
    catch { return null; }
  };
  const saveAnnotations = () => {
    if (!annotationKey) return;
    try { localStorage.setItem(annotationKey, JSON.stringify(annotations)); } catch { /* storage unavailable */ }
  };
  const resolveAnnotationRange = (scope, start, end, quote) => {
    if (!scopeElement(scope)) return null;
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return null;
    const source = annotationTextNodes(scope).map((node) => node.nodeValue ?? "").join("");
    const needle = String(quote ?? "").trim();
    if (needle && source.slice(from, to).trim() !== needle) {
      const relocated = findQuoteOffset(source, from, needle);
      return relocated < 0 ? null : rangeForOffsets(scope, relocated, Math.min(source.length, relocated + needle.length));
    }
    return rangeForOffsets(scope, from, to);
  };
  const removeRenderedHighlights = () => {
    for (const scope of ["passage", "questions"]) {
      const container = scopeElement(scope);
      if (!container) continue;
      for (const mark of container.querySelectorAll("mark.exam-highlight")) {
        if (mark.parentElement?.closest("mark.exam-highlight")) continue;
        const parent = mark.parentElement;
        mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
        parent?.normalize();
      }
    }
  };
  const wrapHighlight = (range, id) => {
    const scope = annotationScope(range.startContainer);
    if (!scope || annotationScope(range.endContainer) !== scope) return;
    const nodes = annotationTextNodes(scope);
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    const startOffset = range.startOffset;
    const endOffset = range.endOffset;
    const startIndex = nodes.indexOf(startNode);
    const endIndex = nodes.indexOf(endNode);
    if (startIndex < 0 || endIndex < startIndex) return;
    const parts = nodes.slice(startIndex, endIndex + 1).map((node, index, list) => ({
      node,
      from: index === 0 ? startOffset : 0,
      to: index === list.length - 1 ? endOffset : (node.nodeValue?.length ?? 0),
    })).filter((part) => part.to > part.from);
    for (const part of parts) {
      part.node.splitText(part.to);
      const before = part.node;
      const content = before.splitText(part.from);
      const mark = document.createElement("mark");
      mark.className = "exam-highlight";
      mark.dataset.highlightId = id;
      content.replaceWith(mark);
      mark.append(content);
    }
  };
  const renderHighlights = () => {
    removeRenderedHighlights();
    for (const item of annotations.highlights) {
      const range = resolveAnnotationRange(item.scope, item.start, item.end, item.quote);
      if (range && !range.collapsed) wrapHighlight(range, item.id);
    }
  };
  const renderNoteList = () => {
    if (!annotationList) return;
    annotationList.replaceChildren();
    if (annotationCount) annotationCount.textContent = String(annotations.notes.length);
    if (annotationEmpty) annotationEmpty.hidden = annotations.notes.length > 0;
    for (const note of annotations.notes) {
      const item = document.createElement("li");
      item.className = "exam-note-item";
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "exam-note-jump";
      jump.dataset.noteJump = note.id;
      jump.textContent = note.quote || "Selected text";
      const copy = document.createElement("p");
      copy.className = "exam-note-copy";
      copy.textContent = note.note;
      const editor = document.createElement("div");
      editor.className = "exam-note-editor";
      editor.hidden = true;
      const textarea = document.createElement("textarea");
      textarea.value = note.note;
      textarea.setAttribute("aria-label", "Edit note");
      const saveEdit = document.createElement("button");
      saveEdit.type = "button";
      saveEdit.textContent = "Save";
      saveEdit.dataset.noteEditSave = note.id;
      const cancelEdit = document.createElement("button");
      cancelEdit.type = "button";
      cancelEdit.textContent = "Cancel";
      cancelEdit.dataset.noteEditCancel = note.id;
      editor.append(textarea, saveEdit, cancelEdit);
      const actions = document.createElement("div");
      actions.className = "exam-note-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.dataset.noteEdit = note.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.dataset.noteDelete = note.id;
      actions.append(edit, remove);
      item.append(jump, copy, editor, actions);
      annotationList.append(item);
    }
  };
  const applyFontSize = (value) => {
    const size = [16, 18, 20].includes(Number(value)) ? Number(value) : 16;
    root.querySelector(".exam-shell")?.style.setProperty("--exam-copy-size", `${size}px`);
    for (const button of root.querySelectorAll("[data-font-size]")) {
      const active = Number(button.getAttribute("data-font-size")) === size;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    try { localStorage.setItem(fontKey, String(size)); } catch { /* storage unavailable */ }
  };
  let savedFontSize = 16;
  try { savedFontSize = Number(localStorage.getItem(fontKey)) || 16; } catch { /* storage unavailable */ }
  applyFontSize(savedFontSize);
  renderHighlights();
  renderNoteList();

  const hideSelectionMenu = () => { if (selectionMenu) selectionMenu.hidden = true; };
  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const scope = annotationScope(range.startContainer);
    if (!scope || annotationScope(range.endContainer) !== scope) return null;
    const start = offsetForBoundary(scope, range.startContainer, range.startOffset);
    const end = offsetForBoundary(scope, range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) return null;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const quote = annotationTextNodes(scope).map((node) => node.nodeValue ?? "").join("").slice(from, to).trim();
    if (!quote) return null;
    return { id: crypto.randomUUID(), scope, start: from, end: to, quote: quote.slice(0, 3000) };
  };
  const showSelectionMenu = () => {
    const record = captureSelection();
    if (!record || !selectionMenu) { hideSelectionMenu(); return; }
    pendingSelection = record;
    const range = window.getSelection()?.getRangeAt(0);
    const rect = range?.getBoundingClientRect();
    if (!rect) return;
    selectionMenu.hidden = false;
    const width = selectionMenu.offsetWidth || 180;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const top = rect.top > 54 ? rect.top - 46 : rect.bottom + 8;
    selectionMenu.style.left = `${left}px`;
    selectionMenu.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, top))}px`;
  };
  const closeNoteComposer = () => {
    if (noteComposer) noteComposer.hidden = true;
    pendingSelection = null;
  };
  const openNoteComposer = () => {
    if (!pendingSelection || !noteComposer) return;
    const selected = root.querySelector("[data-note-selection]");
    if (selected) selected.textContent = pendingSelection.quote.slice(0, 180);
    if (noteInput instanceof HTMLTextAreaElement) { noteInput.value = ""; noteInput.focus(); }
    noteComposer.hidden = false;
    const left = Number.parseFloat(selectionMenu?.style.left ?? "0") || 8;
    const top = Number.parseFloat(selectionMenu?.style.top ?? "0") || 60;
    noteComposer.style.left = `${Math.max(8, Math.min(window.innerWidth - 330, left))}px`;
    noteComposer.style.top = `${Math.max(8, Math.min(window.innerHeight - 250, top + 40))}px`;
    hideSelectionMenu();
  };
  add(root, "mouseup", () => requestAnimationFrame(showSelectionMenu));
  add(root, "keyup", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("input,textarea,button,select")) return;
    requestAnimationFrame(showSelectionMenu);
  });
  add(document, "scroll", hideSelectionMenu, true);

  const questionNode = (id) => root.querySelector(`[data-question="${cssEscape(id)}"]`);
  const cellNode = (id) => root.querySelector(`.exam-cell[data-cell="${cssEscape(id)}"]`);
  const answered = (id) => typeof answers[id] === "string" && answers[id].trim() !== "";
  const parts = activity.examParts ?? [];
  const partStorageKey = `ielts-exam-part-${attemptId}`;
  let currentPart;
  function selectPart(number) {
    const part = parts.find((item) => item.part === Number(number));
    if (!part || currentPart === part.part) return;
    currentPart = part.part;
    for (const node of root.querySelectorAll("[data-exam-part]")) node.hidden = Number(node.dataset.examPart) !== part.part;
    for (const node of root.querySelectorAll("[data-passage-id]")) node.hidden = node.dataset.passageId !== part.passageId;
    for (const node of root.querySelectorAll("[data-part-tab]")) node.setAttribute("aria-selected", String(Number(node.dataset.partTab) === part.part));
    const title = root.querySelector("[data-current-part]");
    if (title) title.textContent = `${activity.pluginId === "reading" ? "Passage" : "Part"} ${part.part}`;
    const questions = activity.questions.filter((question) => part.questionIds.includes(question.id));
    const instruction = root.querySelector("[data-part-instruction]");
    if (instruction) instruction.textContent = `${activity.pluginId === "reading" ? "Read the passage" : "Listen to the recording"} and answer Questions ${questions[0]?.displayNumber}–${questions.at(-1)?.displayNumber}.`;
    if (questionsContainer) { questionsContainer.scrollTop = 0; questionsContainer.dispatchEvent(new Event("scroll")); }
    const passageScroll = root.querySelector(".exam-passage-scroll");
    if (passageScroll) passageScroll.scrollTop = 0;
    try { localStorage.setItem(partStorageKey, String(part.part)); } catch { /* storage unavailable */ }
    setCurrent(questions[0]?.id ?? "");
  }

  function syncCell(id) {
    const cell = cellNode(id);
    if (cell) cell.classList.toggle("is-answered", answered(id));
    questionNode(id)?.closest(".exam-q")?.classList.toggle("has-answer", answered(id));
  }
  function syncProgress() {
    if (hasResult) return;
    const ids = new Set([...root.querySelectorAll("[data-question]")].map((node) => node.getAttribute("data-question") ?? "").filter(Boolean));
    const done = [...ids].filter((id) => answered(id)).length;
    const note = root.querySelector("[data-exam-progress]");
    if (note) note.textContent = `Answered ${done} / ${ids.size}`;
  }
  function setCurrent(id) {
    for (const node of root.querySelectorAll(".is-current")) node.classList.remove("is-current");
    const target = questionNode(id);
    target?.closest(".exam-q")?.classList.add("is-current");
    target?.classList.add("is-current");
    cellNode(id)?.classList.add("is-current");
    onCurrentQuestion?.(id);
  }
  function syncSharedLetters() {
    const holders = new Map();
    for (const question of root.querySelectorAll(".exam-q[data-answer-group]")) {
      const checked = question.querySelector('input[type="radio"]:checked');
      if (!checked) continue;
      const gid = question.getAttribute("data-answer-group");
      const holder = holders.get(gid) ?? new Map();
      if (!holder.has(checked.value)) holder.set(checked.value, question.getAttribute("data-question"));
      holders.set(gid, holder);
    }
    for (const question of root.querySelectorAll(".exam-q[data-answer-group]")) {
      const gid = question.getAttribute("data-answer-group");
      const qid = question.getAttribute("data-question");
      const holder = holders.get(gid) ?? new Map();
      for (const input of question.querySelectorAll('input[type="radio"]')) {
        const owner = holder.get(input.value);
        const taken = Boolean(owner) && owner !== qid;
        input.disabled = hasResult || taken;
        input.closest("label")?.classList.toggle("is-taken", taken);
      }
    }
  }
  function updateCount(input) {
    const id = input.getAttribute("name") ?? "";
    const counter = root.querySelector(`[data-count-for="${cssEscape(id)}"]`);
    if (!counter) return;
    const total = (input.value.trim().match(/\S+/g) ?? []).length;
    const limit = Number((counter.textContent ?? "0/0").split("/")[1] ?? "0");
    counter.textContent = `${total}/${limit}`;
    counter.classList.toggle("is-over", Boolean(limit) && total > limit);
    counter.hidden = !input.value;
  }
  function jumpTo(id) {
    const part = parts.find((item) => item.questionIds.includes(id));
    if (part) selectPart(part.part);
    const target = questionNode(id);
    if (!target) return;
    const scroller = scrollParent(target);
    if (scroller) {
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 18;
      scroller.scrollTo({ top: Math.max(0, delta), behavior: "smooth" });
    } else {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    target.querySelector("input:not(:disabled)")?.focus({ preventScroll: true });
    cellNode(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // 双栏宽度拖拽（阅读）：28%–72% 之间，双击/回车复位，比例记住为用户偏好
  const split = root.querySelector(".exam-split");
  const splitter = root.querySelector("[data-splitter]");
  if (split && splitter) {
    const SPLIT_KEY = "ielts-exam-split-ratio";
    const clamp = (value) => Math.min(72, Math.max(28, value));
    const applyRatio = (value) => split.style.setProperty("--exam-pw", `${clamp(value)}%`);
    const persist = () => {
      try {
        const current = parseFloat(getComputedStyle(split).getPropertyValue("--exam-pw"));
        if (Number.isFinite(current)) localStorage.setItem(SPLIT_KEY, String(Math.round(current * 10) / 10));
      } catch { /* storage unavailable */ }
    };
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      if (Number.isFinite(saved) && saved >= 28 && saved <= 72) applyRatio(saved);
    } catch { /* storage unavailable */ }
    let dragging = false;
    const ratioFromX = (clientX) => {
      const rect = split.getBoundingClientRect();
      if (!rect.width) return 50;
      return ((clientX - rect.left) / rect.width) * 100;
    };
    add(splitter, "pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      splitter.classList.add("is-dragging");
      try { splitter.setPointerCapture(event.pointerId); } catch { /* capture unsupported */ }
    });
    add(splitter, "pointermove", (event) => { if (dragging) applyRatio(ratioFromX(event.clientX)); });
    add(splitter, "pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("is-dragging");
      try { splitter.releasePointerCapture(event.pointerId); } catch { /* release unsupported */ }
      persist();
    });
    add(splitter, "pointercancel", () => { dragging = false; splitter.classList.remove("is-dragging"); });
    add(splitter, "dblclick", () => { applyRatio(50); persist(); });
    add(splitter, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applyRatio(50);
        persist();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = parseFloat(getComputedStyle(split).getPropertyValue("--exam-pw")) || 50;
      applyRatio(current + (event.key === "ArrowRight" ? 3 : -3));
      persist();
    });
  }

  // 展开 / 收起文章（真机 ⤢ 行为：文章占满，题目隐藏）
  const expandButton = root.querySelector("[data-expand-passage]");
  if (expandButton && split) {
    add(expandButton, "click", () => {
      const expanded = split.classList.toggle("is-expanded");
      expandButton.classList.toggle("is-on", expanded);
      expandButton.setAttribute("aria-pressed", String(expanded));
      expandButton.setAttribute("aria-label", expanded ? "Collapse passage" : "Expand passage");
    });
  }

  // 右下角组间箭头：上一组 / 下一组题
  const allGroupHeads = [...root.querySelectorAll(".exam-group")];
  const visibleGroupHeads = () => allGroupHeads.filter((head) => !head.closest("[hidden]"));
  const prevGroup = root.querySelector("[data-group-prev]");
  const nextGroup = root.querySelector("[data-group-next]");
  if (questionsContainer && allGroupHeads.length > 1) {
    const groupScroller = scrollParent(questionsContainer);
    const currentIndex = () => {
      const mid = groupScroller
        ? groupScroller.getBoundingClientRect().top + groupScroller.clientHeight * 0.25
        : window.innerHeight * 0.25;
      let index = 0;
      visibleGroupHeads().forEach((head, position) => {
        if (head.getBoundingClientRect().top <= mid) index = position;
      });
      return index;
    };
    const syncGroupNav = () => {
      const index = currentIndex();
      if (prevGroup) prevGroup.disabled = index <= 0;
      if (nextGroup) nextGroup.disabled = index >= visibleGroupHeads().length - 1;
    };
    const goGroup = (delta) => {
      const heads = visibleGroupHeads();
      const head = heads[Math.min(heads.length - 1, Math.max(0, currentIndex() + delta))];
      if (!head) return;
      if (groupScroller) {
        const deltaTop = head.getBoundingClientRect().top - groupScroller.getBoundingClientRect().top + groupScroller.scrollTop - 8;
        groupScroller.scrollTo({ top: Math.max(0, deltaTop), behavior: "smooth" });
      } else {
        head.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    add(prevGroup, "click", () => goGroup(-1));
    add(nextGroup, "click", () => goGroup(1));
    add(groupScroller ?? window, "scroll", syncGroupNav, { passive: true });
    syncGroupNav();
  }

  add(root, "change", (event) => {
    if (hasResult) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "radio" || !target.name) return;
    answers[target.name] = target.value;
    questionNode(target.name)?.closest(".exam-q")?.classList.add("has-answer");
    syncCell(target.name);
    syncProgress();
    syncSharedLetters();
    setCurrent(target.name);
    onAnswer?.({ ...answers });
  });
  add(root, "input", (event) => {
    if (hasResult) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-blank")) return;
    answers[target.name] = target.value;
    updateCount(target);
    syncCell(target.name);
    syncProgress();
    setCurrent(target.name);
    onAnswer?.({ ...answers });
  });
  add(root, "focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const id = target.name || target.closest("[data-question]")?.getAttribute("data-question");
    if (id) setCurrent(id);
  });
  add(root, "click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const partTab = target.closest("[data-part-tab]");
    if (partTab) { selectPart(partTab.dataset.partTab); return; }
    const reviewDialog = root.querySelector("[data-submit-dialog]");
    if (target.closest("[data-review-cancel]")) { reviewDialog?.close(); return; }
    if (target.closest("[data-confirm-submit]") && !hasResult) {
      reviewDialog?.close();
      onSubmit?.({ ...answers });
      return;
    }
    const transcriptButton = target.closest("[data-transcript-toggle]");
    if (transcriptButton instanceof HTMLElement) {
      const open = Boolean(transcriptPanel?.hidden);
      if (transcriptPanel) transcriptPanel.hidden = !open;
      transcriptToggle?.setAttribute("aria-expanded", String(open));
      root.querySelector(".exam-split")?.classList.toggle("has-transcript", open);
      if (open) void loadTranscript();
      return;
    }
    if (target.closest("[data-transcript-close]")) {
      if (transcriptPanel) transcriptPanel.hidden = true;
      transcriptToggle?.setAttribute("aria-expanded", "false");
      root.querySelector(".exam-split")?.classList.remove("has-transcript");
      return;
    }
    const originalToggle = target.closest("[data-transcript-original]");
    if (originalToggle instanceof HTMLElement) {
      const show = originalToggle.getAttribute("aria-pressed") !== "true";
      originalToggle.setAttribute("aria-pressed", String(show));
      for (const node of root.querySelectorAll("[data-transcript-original-text]")) node.hidden = !show;
      return;
    }
    const chineseToggle = target.closest("[data-transcript-chinese]");
    if (chineseToggle instanceof HTMLElement) {
      const show = chineseToggle.getAttribute("aria-pressed") !== "true";
      chineseToggle.setAttribute("aria-pressed", String(show));
      for (const node of root.querySelectorAll("[data-transcript-chinese-text]")) node.hidden = !show;
      return;
    }
    const analysisToggle = target.closest("[data-transcript-analysis]");
    if (analysisToggle instanceof HTMLElement) {
      const open = Boolean(transcriptAnalysisPanel?.hidden);
      if (transcriptAnalysisPanel) transcriptAnalysisPanel.hidden = !open;
      analysisToggle.setAttribute("aria-expanded", String(open));
      if (open) void loadAnalysis();
      return;
    }
    if (target.closest("[data-transcript-analysis-retry]")) {
      analysisLoaded = false;
      void loadAnalysis();
      return;
    }
    if (target.closest("[data-transcript-retry]")) {
      transcriptLoaded = false;
      void loadTranscript();
      return;
    }
    const notesToggle = target.closest("[data-notes-toggle]");
    if (notesToggle instanceof HTMLElement) {
      const open = Boolean(annotationPanel?.hidden);
      if (annotationPanel) annotationPanel.hidden = !open;
      notesToggle.setAttribute("aria-expanded", String(open));
      if (fontPanel) fontPanel.hidden = true;
      root.querySelector("[data-font-toggle]")?.setAttribute("aria-expanded", "false");
      renderNoteList();
      return;
    }
    if (target.closest("[data-notes-close]")) {
      if (annotationPanel) annotationPanel.hidden = true;
      root.querySelector("[data-notes-toggle]")?.setAttribute("aria-expanded", "false");
      return;
    }
    const fontToggle = target.closest("[data-font-toggle]");
    if (fontToggle instanceof HTMLElement) {
      const open = Boolean(fontPanel?.hidden);
      if (fontPanel) fontPanel.hidden = !open;
      fontToggle.setAttribute("aria-expanded", String(open));
      if (annotationPanel) annotationPanel.hidden = true;
      root.querySelector("[data-notes-toggle]")?.setAttribute("aria-expanded", "false");
      return;
    }
    const fontSize = target.closest("[data-font-size]");
    if (fontSize instanceof HTMLElement) {
      applyFontSize(fontSize.getAttribute("data-font-size"));
      if (fontPanel) fontPanel.hidden = true;
      root.querySelector("[data-font-toggle]")?.setAttribute("aria-expanded", "false");
      return;
    }
    const annotationAction = target.closest("[data-annotation-action]");
    if (annotationAction instanceof HTMLElement && pendingSelection) {
      if (annotationAction.getAttribute("data-annotation-action") === "highlight") {
        annotations.highlights.push({ ...pendingSelection });
        saveAnnotations();
        renderHighlights();
        window.getSelection()?.removeAllRanges();
        hideSelectionMenu();
        pendingSelection = null;
      } else {
        openNoteComposer();
      }
      return;
    }
    if (target.closest("[data-note-cancel]")) {
      closeNoteComposer();
      return;
    }
    if (target.closest("[data-note-save]")) {
      const note = noteInput instanceof HTMLTextAreaElement ? noteInput.value.trim() : "";
      if (pendingSelection && note) {
        annotations.notes.push({ ...pendingSelection, note });
        saveAnnotations();
        renderNoteList();
        if (annotationPanel) annotationPanel.hidden = false;
        root.querySelector("[data-notes-toggle]")?.setAttribute("aria-expanded", "true");
      }
      closeNoteComposer();
      window.getSelection()?.removeAllRanges();
      return;
    }
    const noteJump = target.closest("[data-note-jump]");
    if (noteJump instanceof HTMLElement) {
      const note = annotations.notes.find((item) => item.id === noteJump.getAttribute("data-note-jump"));
      const range = note && resolveAnnotationRange(note.scope, note.start, note.end, note.quote);
      if (range) {
        const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
        const questionPart = element?.closest("[data-exam-part]")?.dataset.examPart;
        const passageId = element?.closest("[data-passage-id]")?.dataset.passageId;
        const part = parts.find((item) => item.part === Number(questionPart) || (passageId && item.passageId === passageId));
        if (part) selectPart(part.part);
        const scroller = scrollParent(range.startContainer);
        const rect = range.getBoundingClientRect();
        if (scroller) scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2), behavior: "smooth" });
        else window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight / 2), behavior: "smooth" });
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      return;
    }
    const noteEdit = target.closest("[data-note-edit]");
    if (noteEdit instanceof HTMLElement) {
      const item = noteEdit.closest(".exam-note-item");
      const editor = item?.querySelector(".exam-note-editor");
      const copy = item?.querySelector(".exam-note-copy");
      if (editor instanceof HTMLElement) editor.hidden = false;
      if (copy instanceof HTMLElement) copy.hidden = true;
      item?.querySelector("textarea")?.focus();
      return;
    }
    const noteEditCancel = target.closest("[data-note-edit-cancel]");
    if (noteEditCancel instanceof HTMLElement) {
      const item = noteEditCancel.closest(".exam-note-item");
      const editor = item?.querySelector(".exam-note-editor");
      const copy = item?.querySelector(".exam-note-copy");
      if (editor instanceof HTMLElement) editor.hidden = true;
      if (copy instanceof HTMLElement) copy.hidden = false;
      return;
    }
    const noteEditSave = target.closest("[data-note-edit-save]");
    if (noteEditSave instanceof HTMLElement) {
      const id = noteEditSave.getAttribute("data-note-edit-save");
      const item = annotations.notes.find((entry) => entry.id === id);
      const value = noteEditSave.closest(".exam-note-item")?.querySelector("textarea")?.value.trim();
      if (item && value) {
        item.note = value;
        saveAnnotations();
        renderNoteList();
      }
      return;
    }
    const noteDelete = target.closest("[data-note-delete]");
    if (noteDelete instanceof HTMLElement) {
      const id = noteDelete.getAttribute("data-note-delete");
      annotations.notes = annotations.notes.filter((entry) => entry.id !== id);
      saveAnnotations();
      renderNoteList();
      return;
    }
    const jump = target.closest("[data-jump]");
    if (jump instanceof HTMLElement) {
      event.preventDefault();
      const id = jump.getAttribute("data-jump") ?? "";
      if (reviewDialog?.open) reviewDialog.close();
      jumpTo(id);
      setCurrent(id);
      return;
    }
    const flag = target.closest("[data-flag]");
    if (flag instanceof HTMLElement) {
      const id = flag.getAttribute("data-flag") ?? "";
      const on = !flags.has(id);
      if (on) flags.add(id); else flags.delete(id);
      flag.setAttribute("aria-pressed", String(on));
      flag.classList.toggle("is-on", on);
      cellNode(id)?.classList.toggle("is-flagged", on);
      writeFlags();
      return;
    }
    const tab = target.closest("[data-audio-tab]");
    if (tab instanceof HTMLElement) {
      const src = tab.getAttribute("data-audio-src");
      const audio = root.querySelector("[data-audio]");
      if (audio instanceof HTMLAudioElement && src) {
        audio.src = src;
        for (const button of root.querySelectorAll("[data-audio-tab]")) {
          const active = button === tab;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-selected", String(active));
        }
        void audio.play().catch(() => undefined);
      }
      return;
    }
    const submit = target.closest("[data-submit]");
    if (submit instanceof HTMLElement && !hasResult && !submit.hasAttribute("disabled")) {
      const questions = activity.questions ?? [];
      const done = questions.filter((question) => answered(question.id)).length;
      const summary = root.querySelector("[data-review-summary]");
      if (summary) summary.textContent = `${done} answered · ${questions.length - done} unanswered · ${flags.size} marked for review`;
      const grid = root.querySelector("[data-review-grid]");
      if (grid) grid.innerHTML = questions.map((question) => `<button type="button" data-jump="${text(question.id)}" class="exam-review-question${answered(question.id) ? " is-answered" : ""}${flags.has(question.id) ? " is-flagged" : ""}" aria-label="Question ${question.displayNumber ?? questions.indexOf(question) + 1}, ${answered(question.id) ? "answered" : "unanswered"}${flags.has(question.id) ? ", marked for review" : ""}">${question.displayNumber ?? questions.indexOf(question) + 1}${flags.has(question.id) ? " ⚑" : ""}</button>`).join("");
      reviewDialog?.showModal();
    }
  });

  const audio = root.querySelector("[data-audio]");
  if (audio instanceof HTMLAudioElement && draft.mode === "mock" && !hasResult) {
    cleanups.push(mountMockAudio(root, activity, draft, onAudioInterrupted, now));
  } else if (audio instanceof HTMLAudioElement) {
    cleanups.push(() => { audio.pause(); audio.removeAttribute("src"); audio.load(); });
    const toggle = root.querySelector("[data-audio-toggle]");
    const icon = root.querySelector("[data-audio-icon]");
    const track = root.querySelector("[data-audio-track]");
    const fill = root.querySelector("[data-audio-fill]");
    const now = root.querySelector("[data-audio-now]");
    const len = root.querySelector("[data-audio-len]");
    const volume = root.querySelector("[data-audio-vol]");
    const syncIcon = () => {
      const playing = !audio.paused && !audio.ended;
      if (icon) icon.textContent = playing ? "⏸" : "▶";
      toggle?.setAttribute("aria-label", playing ? "Pause" : "Play");
    };
    add(toggle, "click", () => { if (audio.paused) void audio.play().catch(() => undefined); else audio.pause(); });
    add(audio, "play", syncIcon);
    add(audio, "pause", syncIcon);
    add(audio, "ended", syncIcon);
    add(audio, "loadedmetadata", () => { if (len) len.textContent = formatClock(audio.duration); });
    add(audio, "timeupdate", () => {
      const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
      if (fill) fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
      if (now) now.textContent = formatClock(audio.currentTime);
      if (track) track.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    });
    add(track, "click", (event) => {
      if (!audio.duration || !track) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    });
    add(track, "keydown", (event) => {
      if (!audio.duration || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + (event.key === "ArrowRight" ? 5 : -5)));
    });
    if (volume instanceof HTMLInputElement) add(volume, "input", () => { audio.volume = Number(volume.value); });
    if (typeof onAudioInterrupted === "function") {
      add(audio, "error", () => onAudioInterrupted("音频播放中断（error）"));
    }
    syncIcon();
  }

  for (const node of root.querySelectorAll("[data-flag]")) {
    const id = node.getAttribute("data-flag") ?? "";
    const on = flags.has(id);
    node.classList.toggle("is-on", on);
    node.setAttribute("aria-pressed", String(on));
    cellNode(id)?.classList.toggle("is-flagged", on);
  }
  for (const input of root.querySelectorAll("[data-blank]")) {
    if (input instanceof HTMLInputElement) updateCount(input);
  }
  syncSharedLetters();
  for (const id of new Set([...root.querySelectorAll("[data-question]")].map((node) => node.getAttribute("data-question") ?? ""))) syncCell(id);
  syncProgress();
  if (parts.length) {
    let savedPart;
    try { savedPart = Number(localStorage.getItem(partStorageKey)); } catch { /* storage unavailable */ }
    selectPart(parts.some((part) => part.part === savedPart) ? savedPart : parts[0].part);
  }

  let observer;
  if (!hasResult && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = visible?.target instanceof HTMLElement ? visible.target.getAttribute("data-question") : null;
      if (id) setCurrent(id);
    }, { root: questionsContainer ? scrollParent(questionsContainer) : null, threshold: [0.25, 0.6, 0.9] });
    for (const node of root.querySelectorAll("[data-question]")) observer.observe(node);
    cleanups.push(() => observer?.disconnect());
  }

  return () => {
    for (const dispose of cleanups.splice(0)) dispose();
  };
}
