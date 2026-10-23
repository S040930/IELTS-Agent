import { StoreError } from "./store-error.js";

export class HttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ErrorResponse {
  status: number;
  body: { error: string };
}

export function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpError || error instanceof StoreError) {
    return { status: error.status, body: { error: error.message } };
  }
  return { status: 500, body: { error: "服务暂时不可用，请稍后重试。" } };
}
