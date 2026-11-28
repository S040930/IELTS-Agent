import type { IncomingMessage } from "node:http";
import { HttpError } from "../http-error.js";

export const speakingModel = "qwen3.8-omni-flash-realtime";

export function speakingConfigurationError(): string | null {
  if (!process.env.DASHSCOPE_API_KEY?.trim()) return "实时口语尚未配置 DASHSCOPE_API_KEY。";
  if (!/^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(process.env.IELTS_REALTIME_HOST ?? "")) {
    return "请将 IELTS_REALTIME_HOST 设置为百炼控制台的业务空间域名。";
  }
  return null;
}

export async function exchangeSpeakingOffer(req: IncomingMessage): Promise<string> {
  const configurationError = speakingConfigurationError();
  if (configurationError) throw new HttpError(configurationError, 503);
  if (req.headers["content-type"]?.split(";")[0] !== "application/sdp") throw new HttpError("需要 SDP 会话描述。", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 128_000) throw new HttpError("会话描述过长。", 413);
    chunks.push(bytes);
  }
  const offer = Buffer.concat(chunks).toString("utf8");
  if (!/^v=0\r?\n/.test(offer) || !/^m=audio /m.test(offer)) throw new HttpError("音频会话描述无效。");
  const url = new URL("/api/v1/webrtc/realtime", "https://" + process.env.IELTS_REALTIME_HOST);
  url.searchParams.set("model", speakingModel);
  try {
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: "Bearer " + process.env.DASHSCOPE_API_KEY, "Content-Type": "application/sdp" },
      body: offer, redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) throw new HttpError("百炼鉴权失败，请核对业务空间、地域、密钥和模型权限。", 502);
    if (response.status === 429) throw new HttpError("百炼实时服务繁忙，请稍后再试。", 429);
    if (!response.ok) throw new HttpError("百炼未能建立通话，请检查模型是否已开通。", 502);
    const answer = await response.text();
    if (!/^v=0\r?\n/.test(answer) || !/^m=audio /m.test(answer)) throw new HttpError("百炼返回的音频会话描述无效。", 502);
    return answer;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("连接百炼超时或网络不可用，请重试。", 502);
  }
}
