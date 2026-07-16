import type { ProviderError, ProviderErrorCode } from "./provider-types";

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly requestId?: unknown;
  readonly retryAfterMs?: unknown;
  readonly retryAfter?: unknown;
}

const SAFE_MESSAGES: Readonly<Record<ProviderErrorCode, string>> = {
  "auth-failed": "Providerの認証に失敗しました。",
  "rate-limited": "Providerの利用制限に達しました。",
  timeout: "Providerへの通信がタイムアウトしました。",
  "bad-request": "Providerへのリクエストを処理できませんでした。",
  "context-exceeded": "入力がモデルのコンテキスト上限を超えています。",
  unsupported: "Providerまたはモデルが要求された機能に対応していません。",
  network: "Providerへのネットワーク接続に失敗しました。",
  cancelled: "Providerへのリクエストはキャンセルされました。",
  unknown: "Providerで予期しないエラーが発生しました。",
};

export function normalizeProviderError(
  input: unknown,
  options: { readonly signal?: AbortSignal; readonly requestId?: string } = {},
): ProviderError {
  if (options.signal?.aborted || isAbortError(input)) {
    return createProviderError("cancelled", options.requestId);
  }

  const error = asErrorLike(input);
  const status = finiteInteger(error.status ?? error.statusCode);
  const code = classifyError(error, status);
  const retryAfterMs = normalizeRetryAfter(error.retryAfterMs ?? error.retryAfter);

  return {
    code,
    message: SAFE_MESSAGES[code],
    retryable: isRetryable(code),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(status === undefined ? {} : { status }),
    ...(safeRequestId(error.requestId ?? options.requestId) === undefined
      ? {}
      : { requestId: safeRequestId(error.requestId ?? options.requestId) }),
  };
}

export function createProviderError(
  code: ProviderErrorCode,
  requestId?: string,
  details: Pick<ProviderError, "status" | "retryAfterMs"> = {},
): ProviderError {
  return {
    code,
    message: SAFE_MESSAGES[code],
    retryable: isRetryable(code),
    ...(details.status === undefined ? {} : { status: details.status }),
    ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    ...(safeRequestId(requestId) === undefined ? {} : { requestId: safeRequestId(requestId) }),
  };
}

export function isAbortError(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const error = input as ErrorLike;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

function classifyError(error: ErrorLike, status: number | undefined): ProviderErrorCode {
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";

  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth-failed";
    if (status === 429) return "rate-limited";
    if (status === 408) return "timeout";
    if (status === 400 || status === 422) return "bad-request";
    if (status === 413) return "context-exceeded";
    if (status === 404) return "unsupported";
  }
  if (/auth|credential|api.?key|unauthori/.test(code + message)) return "auth-failed";
  if (/rate.?limit|too many requests/.test(code + message)) return "rate-limited";
  if (/timeout|timed out/.test(code + message)) return "timeout";
  if (/context.{0,20}(length|window|exceed)|too many tokens/.test(message)) {
    return "context-exceeded";
  }
  if (/unsupported|not implemented/.test(code + message)) return "unsupported";
  if (/network|fetch|socket|econn|dns|connection/.test(code + message)) return "network";
  return "unknown";
}

function isRetryable(code: ProviderErrorCode): boolean {
  return code === "rate-limited" || code === "timeout" || code === "network";
}

function asErrorLike(input: unknown): ErrorLike {
  return input && typeof input === "object" ? (input as ErrorLike) : {};
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100
    ? value
    : undefined;
}

function normalizeRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
}
