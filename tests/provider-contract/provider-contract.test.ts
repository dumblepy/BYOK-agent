import { describe, expect, it } from "vitest";

import { normalizeProviderError } from "../../src/providers/provider-error";
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
});
