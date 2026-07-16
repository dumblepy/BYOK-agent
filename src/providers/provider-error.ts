import type {
  ProviderAttemptOutcome,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorSource,
} from "./provider-types";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_PROVIDER_ERROR_BODY_LENGTH = 64 * 1024;

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly requestId?: unknown;
  readonly providerCode?: unknown;
  readonly providerType?: unknown;
  readonly source?: unknown;
  readonly userAborted?: unknown;
  readonly timedOut?: unknown;
  readonly retryAfterMs?: unknown;
  readonly retryAfter?: unknown;
  readonly headers?: unknown;
  readonly deliveryStatus?: unknown;
}

export interface ProviderErrorInput {
  readonly source?: ProviderErrorSource;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly requestId?: string;
  readonly userAborted?: boolean;
  readonly timedOut?: boolean;
  readonly retryAfterMs?: number;
  readonly retryAfter?: string;
  readonly deliveryStatus?: ProviderAttemptOutcome;
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

export async function normalizeProviderHttpError(
  response: Response,
  options: { readonly requestId?: string; readonly nowMs?: number } = {},
): Promise<ProviderError> {
  const metadata = await readProviderErrorMetadata(response);
  const headers = collectHeaders(response.headers);
  return normalizeProviderError(
    {
      source: "http",
      status: response.status,
      headers,
      providerCode: metadata.code,
      providerType: metadata.type,
      requestId: headers["x-request-id"] ?? options.requestId,
      ...(response.status === 429 ? { deliveryStatus: "rejected-before-processing" as const } : {}),
      ...(metadata.code === undefined ? {} : { code: metadata.code }),
    },
    options,
  );
}

export function normalizeProviderError(
  input: unknown,
  options: {
    readonly signal?: AbortSignal;
    readonly requestId?: string;
    readonly nowMs?: number;
  } = {},
): ProviderError {
  if (options.signal?.aborted || isAbortError(input)) {
    return createProviderError("cancelled", options.requestId, {
      source: "cancelled",
    });
  }

  const error = asErrorLike(input);
  const status = finiteStatus(error.status ?? error.statusCode);
  const source = safeSource(error.source) ?? inferSource(error);
  if (error.userAborted === true || source === "cancelled") {
    return createProviderError("cancelled", safeRequestId(error.requestId ?? options.requestId), {
      source: "cancelled",
    });
  }
  const timedOut = error.timedOut === true || source === "timeout";
  const providerCode = safeProviderToken(error.providerCode ?? error.code);
  const providerType = safeProviderToken(error.providerType ?? error.type);
  const code = classifyError({ error, status, source, timedOut, providerCode, providerType });
  const retryAfterMs = normalizeRetryAfter(
    error.retryAfterMs,
    error.retryAfter,
    getHeader(error.headers, "retry-after"),
    options.nowMs,
  );
  const requestId = safeRequestId(error.requestId ?? options.requestId);
  const deliveryStatus = safeDeliveryStatus(error.deliveryStatus);

  return {
    code,
    message: SAFE_MESSAGES[code],
    retryable: isRetryable(code),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerType === undefined ? {} : { providerType }),
    ...(source === undefined ? {} : { source }),
    ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
  };
}

export function createProviderError(
  code: ProviderErrorCode,
  requestId?: string,
  details: Pick<ProviderError, "status" | "retryAfterMs" | "deliveryStatus"> &
    Partial<Pick<ProviderError, "providerCode" | "providerType" | "source">> = {},
): ProviderError {
  return {
    code,
    message: SAFE_MESSAGES[code],
    retryable: isRetryable(code),
    ...(details.status === undefined ? {} : { status: details.status }),
    ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    ...(safeRequestId(requestId) === undefined ? {} : { requestId: safeRequestId(requestId) }),
    ...(details.providerCode === undefined ? {} : { providerCode: details.providerCode }),
    ...(details.providerType === undefined ? {} : { providerType: details.providerType }),
    ...(details.source === undefined ? {} : { source: details.source }),
    ...(details.deliveryStatus === undefined ? {} : { deliveryStatus: details.deliveryStatus }),
  };
}

export function isAbortError(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const error = input as ErrorLike;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

export function normalizeRetryAfter(
  retryAfterMs: unknown,
  retryAfter: unknown,
  headerValue: unknown,
  nowMs = Date.now(),
): number | undefined {
  const direct = finiteNonNegativeInteger(retryAfterMs);
  if (direct !== undefined) return direct <= MAX_RETRY_AFTER_MS ? direct : undefined;

  const value = typeof headerValue === "string" ? headerValue : retryAfter;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds > MAX_RETRY_AFTER_MS / 1000) return undefined;
    return seconds * 1000;
  }
  if (/^[+-]?(?:\d|\.)/.test(trimmed)) return undefined;
  if (!Number.isFinite(nowMs) || !/^.{1,128}$/.test(trimmed)) return undefined;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = Math.max(0, timestamp - nowMs);
  return delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

interface ClassificationInput {
  readonly error: ErrorLike;
  readonly status?: number;
  readonly source?: ProviderErrorSource;
  readonly timedOut: boolean;
  readonly providerCode?: string;
  readonly providerType?: string;
}

function classifyError(input: ClassificationInput): ProviderErrorCode {
  if (input.timedOut) return "timeout";

  if (input.status !== undefined) {
    if (input.status === 401 || input.status === 403) return "auth-failed";
    if (input.status === 429) return "rate-limited";
    if (input.status === 408 || input.status === 504) return "timeout";
    if (input.status === 413) return "context-exceeded";
    if (input.status === 400 || input.status === 422) {
      return classifyProviderToken(input.providerCode, input.providerType) === "context-exceeded"
        ? "context-exceeded"
        : "bad-request";
    }
    if (input.status === 404) return "unsupported";
  }

  const providerCode = classifyProviderToken(input.providerCode, input.providerType);
  if (providerCode) return providerCode;

  if (input.source === "transport") {
    return isTimeoutTransportError(input.error) ? "timeout" : "network";
  }
  return "unknown";
}

function classifyProviderToken(
  ...tokens: readonly (string | undefined)[]
): ProviderErrorCode | undefined {
  for (const token of tokens) {
    switch (token?.toLowerCase()) {
      case "invalid_api_key":
      case "authentication_error":
      case "authentication_failed":
      case "unauthorized":
      case "permission_denied":
      case "invalid_token":
        return "auth-failed";
      case "rate_limit_exceeded":
      case "rate_limit":
      case "too_many_requests":
      case "overloaded":
        return "rate-limited";
      case "timeout":
      case "request_timeout":
      case "deadline_exceeded":
      case "gateway_timeout":
        return "timeout";
      case "context_length_exceeded":
      case "context_exceeded":
      case "input_too_long":
      case "too_many_tokens":
      case "max_context_length":
        return "context-exceeded";
      case "invalid_request_error":
      case "invalid_request":
      case "bad_request":
      case "invalid_parameter":
      case "malformed_request":
      case "invalid_prompt":
        return "bad-request";
      case "not_found":
      case "model_not_found":
      case "unsupported":
      case "not_implemented":
        return "unsupported";
      default:
        break;
    }
  }
  return undefined;
}

function isRetryable(code: ProviderErrorCode): boolean {
  return code === "rate-limited" || code === "timeout" || code === "network";
}

function safeDeliveryStatus(value: unknown): ProviderAttemptOutcome | undefined {
  return value === "not-sent" ||
    value === "rejected-before-processing" ||
    value === "response-started" ||
    value === "unknown"
    ? value
    : undefined;
}

async function readProviderErrorMetadata(
  response: Response,
): Promise<{ readonly code?: string; readonly type?: string }> {
  try {
    const body = await response.clone().text();
    if (body.length > MAX_PROVIDER_ERROR_BODY_LENGTH) return {};
    const parsed: unknown = JSON.parse(body);
    const root = asRecord(parsed);
    const nested = asRecord(root?.error) ?? asRecord(asRecord(root?.response)?.error) ?? root;
    return {
      ...(safeProviderToken(nested?.code) === undefined
        ? {}
        : { code: safeProviderToken(nested?.code) }),
      ...(safeProviderToken(nested?.type) === undefined
        ? {}
        : { type: safeProviderToken(nested?.type) }),
    };
  } catch {
    return {};
  }
}

function asErrorLike(input: unknown): ErrorLike {
  return input && typeof input === "object" ? (input as ErrorLike) : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function getHeader(headers: unknown, name: string): string | undefined {
  const record = asRecord(headers);
  if (!record) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === expected && typeof value === "string") return value;
  }
  return undefined;
}

function finiteStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeProviderToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeSource(value: unknown): ProviderErrorSource | undefined {
  return value === "http" ||
    value === "transport" ||
    value === "stream" ||
    value === "timeout" ||
    value === "cancelled"
    ? value
    : undefined;
}

function inferSource(error: ErrorLike): ProviderErrorSource | undefined {
  if (error.timedOut === true) return "timeout";
  if (isNetworkError(error)) return "transport";
  return undefined;
}

function isTimeoutTransportError(error: ErrorLike): boolean {
  const token = `${String(error.name ?? "")} ${String(error.code ?? "")}`.toLowerCase();
  return (
    token === "aborterror etimedout" ||
    /(^|\s)(etimedout|und_err_connect_timeout|request_timeout|timeout)(\s|$)/.test(token)
  );
}

function isNetworkError(error: ErrorLike): boolean {
  const token =
    `${String(error.name ?? "")} ${String(error.code ?? "")} ${String(error.message ?? "")}`.toLowerCase();
  return /(^|\s)(etimedout|econnreset|econnrefused|enotfound|eai_again|fetch failed|network error|networkerror|socket hang up)(\s|$)/.test(
    token,
  );
}
