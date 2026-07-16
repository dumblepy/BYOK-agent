import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { OpenAIResponsesAdapter } from "../../src/providers/openai/openai-responses-adapter";
import { toResponsesRequest } from "../../src/providers/openai/openai-responses-request";
import type { ProviderRequest } from "../../src/providers/provider-types";

const baseRequest: ProviderRequest = {
  requestId: "request-1",
  modelId: "gpt-test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

describe("OpenAIResponsesAdapter", () => {
  it("system指示、メッセージ、Tool定義、Tool ResultをResponses入力へ変換する", () => {
    const request: ProviderRequest = {
      ...baseRequest,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        { role: "user", content: [{ type: "text", text: "Look up a value." }] },
        {
          role: "assistant",
          content: [],
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { key: "x" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: [{ type: "text", text: "result" }],
        },
      ],
      tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
      options: { maxOutputTokens: 200, reasoningEffort: "low" },
    };

    expect(toResponsesRequest(request)).toEqual({
      model: "gpt-test",
      instructions: "Be concise.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Look up a value." }],
        },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"key":"x"}' },
        { type: "function_call_output", call_id: "call-1", output: "result" },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object" },
        },
      ],
      max_output_tokens: 200,
      reasoning: { effort: "low" },
      stream: true,
      parallel_tool_calls: true,
      truncation: "disabled",
    });
  });

  it("SSEのText、Usage、Stop Reasonを共通イベントへ正規化する", async () => {
    const fetchImpl = fakeFetch([
      readFileSync(join(__dirname, "fixtures/openai-responses/text-usage.sse"), "utf8"),
    ]);
    const adapter = createAdapter(fetchImpl);

    await expect(collect(adapter)).resolves.toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 12, outputTokens: 4, cachedTokens: 2, reasoningTokens: 1 },
      { type: "completed", stopReason: "end-turn" },
    ]);
  });

  it("単一・並列Function Callの断片をcall_id単位で確定する", async () => {
    const fetchImpl = fakeFetch([
      sse("response.output_item.added", {
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: "",
        },
      }),
      sse("response.output_item.added", {
        item: {
          id: "item-2",
          type: "function_call",
          call_id: "call-2",
          name: "lookup",
          arguments: "",
        },
      }),
      sse("response.function_call_arguments.delta", { item_id: "item-1", delta: '{"key":' }),
      sse("response.function_call_arguments.delta", { item_id: "item-2", delta: '{"key":"y"}' }),
      sse("response.function_call_arguments.delta", { item_id: "item-1", delta: '"x"}' }),
      sse("response.function_call_arguments.done", { item_id: "item-1", arguments: '{"key":"x"}' }),
      sse("response.function_call_arguments.done", { item_id: "item-2", arguments: '{"key":"y"}' }),
      sse("response.completed", { response: { status: "completed", usage: null } }),
    ]);
    const adapter = createAdapter(fetchImpl);

    await expect(
      collect(adapter, undefined, {
        ...baseRequest,
        tools: [{ name: "lookup", inputSchema: {} }],
      }),
    ).resolves.toEqual([
      { type: "tool-call-start", id: "call-1", name: "lookup" },
      { type: "tool-call-start", id: "call-2", name: "lookup" },
      { type: "tool-call-delta", id: "call-1", argumentsDelta: '{"key":' },
      { type: "tool-call-delta", id: "call-2", argumentsDelta: '{"key":"y"}' },
      { type: "tool-call-delta", id: "call-1", argumentsDelta: '"x"}' },
      { type: "tool-call", id: "call-1", name: "lookup", arguments: { key: "x" } },
      { type: "tool-call", id: "call-2", name: "lookup", arguments: { key: "y" } },
      { type: "completed", stopReason: "tool-call" },
    ]);
  });

  it("不完全なTool Callでは完了イベントを発行しない", async () => {
    const fetchImpl = fakeFetch([
      sse("response.output_item.added", {
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: "",
        },
      }),
      sse("response.function_call_arguments.delta", { item_id: "item-1", delta: "{" }),
      sse("response.completed", { response: { status: "completed" } }),
    ]);
    const adapter = createAdapter(fetchImpl);

    await expect(
      collect(adapter, undefined, {
        ...baseRequest,
        tools: [{ name: "lookup", inputSchema: {} }],
      }),
    ).resolves.toEqual([
      { type: "tool-call-start", id: "call-1", name: "lookup" },
      { type: "tool-call-delta", id: "call-1", argumentsDelta: "{" },
      { type: "error", error: expect.objectContaining({ code: "bad-request", retryable: false }) },
    ]);
  });

  it("HTTPエラーを分類しRetry-Afterをミリ秒へ変換する", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    ) as unknown as typeof fetch;
    const adapter = createAdapter(fetchImpl);

    await expect(collect(adapter)).resolves.toEqual([
      {
        type: "error",
        error: expect.objectContaining({
          code: "rate-limited",
          retryable: true,
          retryAfterMs: 2000,
          status: 429,
        }),
      },
    ]);
  });

  it("Abort済みならFetchを開始しない", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createAdapter(fetchImpl);
    const controller = new AbortController();
    controller.abort();

    await expect(collect(adapter, controller.signal)).resolves.toEqual([{ type: "cancelled" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createAdapter(fetchImpl: typeof fetch): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter(
    {
      providerId: "openai",
      vendor: "openai",
      apiType: "responses",
      url: "https://api.openai.com/v1/responses",
      headers: {},
      credential: "secret-key",
    },
    { fetchImpl },
  );
}

async function collect(
  adapter: OpenAIResponsesAdapter,
  signal = new AbortController().signal,
  request: ProviderRequest = { ...baseRequest, tools: [] },
) {
  const events = [];
  for await (const event of adapter.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

function fakeFetch(events: readonly string[]): typeof fetch {
  return vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
