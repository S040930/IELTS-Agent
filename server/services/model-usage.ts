type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
}

function rate(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export interface MeasuredUsage {
  input: number | null;
  output: number | null;
  costUsd: number | null;
}

export function textUsage(value: unknown): MeasuredUsage {
  const usage = object(value);
  const input = tokens(usage.prompt_tokens);
  const output = tokens(usage.completion_tokens);
  const inputRate = rate("IELTS_AI_INPUT_USD_PER_MILLION");
  const outputRate = rate("IELTS_AI_OUTPUT_USD_PER_MILLION");
  if (input === null || output === null) return { input: null, output: null, costUsd: null };
  if (inputRate === null || outputRate === null) return { input, output, costUsd: null };
  const cached = Math.min(input, tokens(object(usage.prompt_tokens_details).cached_tokens) ?? 0);
  const cachedRate = rate("IELTS_AI_CACHED_INPUT_USD_PER_MILLION") ?? inputRate;
  const costUsd = ((input - cached) * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
  return { input, output, costUsd: Number.isFinite(costUsd) ? costUsd : null };
}

const voicePrices = {
  "cn-beijing": { inputText: 0.212, inputAudio: 0.848, outputText: 0.636, outputAudio: 1.696 },
  "ap-southeast-1": { inputText: 0.23, inputAudio: 0.93, outputText: 0.70, outputAudio: 1.87 },
};

function audioTokens(value: unknown, total: number): number | null {
  if (total === 0) return 0;
  const details = object(value);
  const text = tokens(details.text_tokens) ?? 0;
  const audio = tokens(details.audio_tokens) ?? 0;
  return text + audio === total ? audio : null;
}

export function voiceUsage(value: unknown, region: string): MeasuredUsage {
  const usage = object(value);
  const input = tokens(usage.input_tokens);
  const output = tokens(usage.output_tokens);
  if (input === null || output === null) return { input: null, output: null, costUsd: null };
  const inputAudio = audioTokens(usage.input_tokens_details, input);
  const outputAudio = audioTokens(usage.output_tokens_details, output);
  const price = voicePrices[region as keyof typeof voicePrices];
  if (!price || inputAudio === null || outputAudio === null) return { input, output, costUsd: null };
  const costUsd = ((input - inputAudio) * price.inputText + inputAudio * price.inputAudio +
    (output - outputAudio) * price.outputText + outputAudio * price.outputAudio) / 1_000_000;
  return { input, output, costUsd };
}
