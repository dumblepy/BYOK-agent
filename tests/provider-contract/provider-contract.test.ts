import { describe, expect, it } from "vitest";

import {
  normalizeProviderError,
  normalizeProviderHttpError,
  normalizeRetryAfter,
} from "../../src/providers/provider-error";
import { toAgentError } from "../../src/agent/agent-error";
import { ToolCallAccumulator } from "../../src/providers/provider-stream";
import type { ProviderAdapter, ProviderRequest } from "../../src/providers/provider-types";

const request: ProviderRequest = {
  requestId: "request-1",
  modelId: "model-1",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

async function collect(adapter: ProviderAdapter, signal = new AbortController().signal) {
  const events = [];
  for await (const event of adapter.stream(request, signal)) events.push(event);
  return events;
}

describe("Provider contract", () => {
  it("AdapterがProvider非依存のイベント列を返せる", async () => {
    const adapter: ProviderAdapter = {
      type: "fake",
      async *stream(_request, signal) {
        if (signal.aborted) return;
        yield { type: "text-delta", text: "hello" };
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "completed", stopReason: "end-turn" };
      },
    };

    await expect(collect(adapter)).resolves.toEqual([
      { type: "text-delta", text: "hello" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "completed", stopReason: "end-turn" },
    ]);
  });

  it("Abort済みの信号では通信イベントを発行しない", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter: ProviderAdapter = {
      type: "fake",
      async *stream(_request, signal) {
        if (signal.aborted) {
          yield { type: "cancelled" };
          return;
        }
        yield { type: "text-delta", text: "must not be emitted" };
      },
    };

    await expect(collect(adapter, controller.signal)).resolves.toEqual([{ type: "cancelled" }]);
  });

  it("Tool Callの引数断片を結合してJSONを確定する", () => {
    const accumulator = new ToolCallAccumulator();
    expect(accumulator.start("call-1", "lookup")).toEqual({
      type: "tool-call-start",
      id: "call-1",
      name: "lookup",
    });
    accumulator.append("call-1", '{"query":');
    accumulator.append("call-1", '"provider"}');
    expect(accumulator.complete("call-1")).toEqual({
      type: "tool-call",
      id: "call-1",
      name: "lookup",
      arguments: { query: "provider" },
    });
    expect(accumulator.finish()).toEqual({ events: [] });
  });

  it("未完了Tool Callを成功扱いにしない", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.start("call-1", "lookup");
    accumulator.append("call-1", "{");
    expect(accumulator.finish().error).toMatchObject({
      code: "bad-request",
      retryable: false,
    });
  });

  it("Providerエラーを安全な共通形式へ正規化する", () => {
    const error = normalizeProviderError({
      status: 429,
      message: "secret api key leaked in provider response",
      retryAfterMs: 1000,
      requestId: "req-123",
    });

    expect(error).toEqual({
      code: "rate-limited",
      message: "Providerの利用制限に達しました。",
      retryable: true,
      retryAfterMs: 1000,
      status: 429,
      requestId: "req-123",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("api key");
  });

  it("Providerコードを有限の共通コードへ分類する", () => {
    expect(
      normalizeProviderError({ source: "http", providerCode: "invalid_api_key" }),
    ).toMatchObject({ code: "auth-failed", retryable: false, providerCode: "invalid_api_key" });
    expect(
      normalizeProviderError({ source: "http", providerCode: "context_length_exceeded" }),
    ).toMatchObject({ code: "context-exceeded", retryable: false });
    expect(
      normalizeProviderError({ source: "http", providerCode: "provider_private_detail" }),
    ).toMatchObject({ code: "unknown", retryable: false });
  });

  it("HTTPステータスをProviderコードより優先する", () => {
    expect(
      normalizeProviderError({
        source: "http",
        status: 400,
        providerCode: "invalid_api_key",
      }),
    ).toMatchObject({ code: "bad-request", retryable: false });
    expect(
      normalizeProviderError({
        source: "http",
        status: 400,
        providerCode: "context_length_exceeded",
      }),
    ).toMatchObject({ code: "context-exceeded", retryable: false });
  });

  it("HTTPエラーBodyから安全なProviderコードだけを抽出する", async () => {
    const error = await normalizeProviderHttpError(
      new Response(
        JSON.stringify({
          error: { code: "invalid_api_key", type: "authentication_error", message: "secret" },
        }),
        { status: 401, headers: { "x-request-id": "req-401" } },
      ),
    );

    expect(error).toMatchObject({
      code: "auth-failed",
      providerCode: "invalid_api_key",
      providerType: "authentication_error",
      status: 401,
      requestId: "req-401",
      source: "http",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("ユーザーAbortを他の分類より優先する", () => {
    expect(normalizeProviderError({ userAborted: true, status: 401 })).toMatchObject({
      code: "cancelled",
      retryable: false,
      source: "cancelled",
    });
  });

  it("Retry-Afterの秒数、HTTP-date、不正値を正規化する", () => {
    const nowMs = Date.parse("2026-07-16T00:00:00.000Z");
    expect(normalizeRetryAfter(undefined, undefined, "2", nowMs)).toBe(2_000);
    expect(normalizeRetryAfter(undefined, undefined, "Thu, 16 Jul 2026 00:00:05 GMT", nowMs)).toBe(
      5_000,
    );
    expect(normalizeRetryAfter(undefined, undefined, "-1", nowMs)).toBeUndefined();
    expect(normalizeRetryAfter(undefined, undefined, "999999999", nowMs)).toBeUndefined();
  });

  it("ProviderErrorをAgentErrorへ一度だけ安全に写像する", () => {
    const providerError = normalizeProviderError({
      source: "http",
      status: 429,
      providerCode: "rate_limit_exceeded",
      providerType: "rate_limit_error",
      requestId: "req-123",
      retryAfterMs: 2_000,
    });
    const agentError = toAgentError(providerError);

    expect(agentError).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      userMessage: "Providerの利用制限に達しました。",
      retryable: true,
      retryAfterMs: 2_000,
      technicalDetails: {
        providerCode: "rate_limit_exceeded",
        providerType: "rate_limit_error",
        status: 429,
        requestId: "req-123",
        source: "http",
      },
    });
    expect(JSON.stringify(agentError)).not.toContain("provider response");
  });
});
