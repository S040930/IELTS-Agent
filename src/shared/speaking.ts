export type SpeakingPart = 1 | 2 | 3;
export interface SpeakingLine {
  id: string;
  role: "learner" | "examiner";
  text: string;
}

export const criteria = {
  fluency: "流利度与连贯性",
  vocabulary: "词汇",
  grammar: "语法",
  pronunciation: "发音",
} as const;

export interface SpeakingFeedback {
  advice: string;
  quote: string;
  revision: string;
  criteria: Record<keyof typeof criteria, { band: number | null; note: string }>;
}

export interface SpeakingSummary {
  id: string;
  part: SpeakingPart;
  topic: string;
  endedAt: string;
}

export interface SpeakingRecord extends SpeakingSummary {
  lines: SpeakingLine[];
  feedback: SpeakingFeedback | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

export function parseFeedback(value: unknown): SpeakingFeedback | null {
  if (!object(value) || !shortText(value.advice, 2000) || !value.advice.trim() ||
      !shortText(value.quote, 2000) || !shortText(value.revision, 2000) || !object(value.criteria)) return null;
  const ratings = {} as SpeakingFeedback["criteria"];
  for (const key of Object.keys(criteria) as (keyof typeof criteria)[]) {
    const rating = value.criteria[key];
    if (!object(rating) || !shortText(rating.note, 2000) || !rating.note.trim()) return null;
    const band = rating.band;
    if (band !== null && (typeof band !== "number" || band < 0 || band > 9 || !Number.isInteger(band * 2))) return null;
    ratings[key] = { band, note: rating.note };
  }
  return { advice: value.advice, quote: value.quote, revision: value.revision, criteria: ratings };
}

export function parseSpeakingRecord(value: unknown): SpeakingRecord | null {
  if (!object(value) || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.id) ||
      (value.part !== 1 && value.part !== 2 && value.part !== 3) ||
      !shortText(value.topic, 150) || !value.topic.trim() || !shortText(value.endedAt, 30) ||
      !Number.isFinite(Date.parse(value.endedAt)) || !Array.isArray(value.lines) || value.lines.length > 500) return null;
  const lines: SpeakingLine[] = [];
  for (const line of value.lines) {
    if (!object(line) || !shortText(line.id, 160) || !shortText(line.text, 16000) ||
        (line.role !== "examiner" && line.role !== "learner")) return null;
    lines.push({ id: line.id, role: line.role, text: line.text });
  }
  const feedback = parseFeedback(value.feedback);
  if (value.feedback !== null && !feedback) return null;
  return { id: value.id, part: value.part, topic: value.topic, endedAt: new Date(value.endedAt).toISOString(), lines, feedback };
}
