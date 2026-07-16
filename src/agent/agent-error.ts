import type { ProviderError, ProviderErrorCode } from "../providers/provider-types";

export type ProviderAgentErrorCode =
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BAD_REQUEST"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_NETWORK"
  | "PROVIDER_UNKNOWN"
  | "MODEL_CONTEXT_EXCEEDED"
  | "USER_CANCELLED";

export interface AgentError {
  readonly code: ProviderAgentErrorCode;
  readonly userMessage: string;
  readonly modelMessage?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly technicalDetails?: {
    readonly providerCode?: string;
    readonly providerType?: string;
    readonly status?: number;
    readonly requestId?: string;
    readonly source?: "http" | "transport" | "stream" | "timeout" | "cancelled";
  };
}

const AGENT_CODES: Readonly<Record<ProviderErrorCode, ProviderAgentErrorCode>> = {
  "auth-failed": "PROVIDER_AUTH_FAILED",
  "rate-limited": "PROVIDER_RATE_LIMITED",
  timeout: "PROVIDER_TIMEOUT",
  "bad-request": "PROVIDER_BAD_REQUEST",
  "context-exceeded": "MODEL_CONTEXT_EXCEEDED",
  unsupported: "PROVIDER_UNSUPPORTED",
  network: "PROVIDER_NETWORK",
  unknown: "PROVIDER_UNKNOWN",
  cancelled: "USER_CANCELLED",
};

const MODEL_MESSAGES: Readonly<Record<ProviderAgentErrorCode, string>> = {
  PROVIDER_AUTH_FAILED: "認証設定を確認してください。",
  PROVIDER_RATE_LIMITED: "時間を置いて再試行してください。",
  PROVIDER_TIMEOUT: "同じ要求を再試行してください。",
  PROVIDER_BAD_REQUEST: "入力またはリクエスト設定を確認してください。",
  MODEL_CONTEXT_EXCEEDED: "入力を短くして再試行してください。",
  PROVIDER_UNSUPPORTED: "対応しているProviderまたはモデルを選択してください。",
  PROVIDER_NETWORK: "Providerへの接続を確認して再試行してください。",
  PROVIDER_UNKNOWN: "Providerの状態を確認して再試行してください。",
  USER_CANCELLED: "追加の操作は不要です。",
};

export function toAgentError(error: ProviderError): AgentError {
  const code = AGENT_CODES[error.code];
  const technicalDetails = {
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.providerType === undefined ? {} : { providerType: error.providerType }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.source === undefined ? {} : { source: error.source }),
  };

  return {
    code,
    userMessage: error.message,
    modelMessage: MODEL_MESSAGES[code],
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(Object.keys(technicalDetails).length === 0 ? {} : { technicalDetails }),
  };
}
