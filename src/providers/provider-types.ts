export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  readonly role: ProviderRole;
  readonly content: readonly ProviderContentPart[];
  readonly toolCallId?: string;
}

export type ProviderContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string };

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface ProviderRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly options: ProviderGenerationOptions;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ProviderGenerationOptions {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
}

export type ProviderStopReason =
  "end-turn" | "tool-call" | "max-tokens" | "content-filter" | "unknown";

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly argumentsDelta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens?: number;
      readonly reasoningTokens?: number;
    }
  | { readonly type: "completed"; readonly stopReason: ProviderStopReason }
  | { readonly type: "error"; readonly error: ProviderError }
  | { readonly type: "cancelled" };

export type ProviderErrorCode =
  | "auth-failed"
  | "rate-limited"
  | "timeout"
  | "bad-request"
  | "context-exceeded"
  | "unsupported"
  | "network"
  | "cancelled"
  | "unknown";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly requestId?: string;
}

export interface TokenCountInput {
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolDefinition[];
}

export interface ProviderAdapter {
  readonly type: string;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  countTokens?(input: TokenCountInput, signal?: AbortSignal): Promise<number>;
  dispose?(): void | Promise<void>;
}
