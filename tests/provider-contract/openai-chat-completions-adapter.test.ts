import { describe, expect, it, vi } from "vitest";

import {
  OpenAIChatCompletionsAdapter,
  type OpenAIChatCompletionsAdapterOptions,
} from "../../src/providers/openai/openai-chat-completions-adapter";
import { toChatCompletionsRequest } from "../../src/providers/openai/openai-chat-completions-request";
import type { ProviderRequest } from "../../src/providers/provider-types";

const baseRequest: ProviderRequest = {
  requestId: "request-1",
  modelId: "model-test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

describe("OpenAIChatCompletionsAdapter", () => {
  it("メッセージ、画像、Tool定義、Tool ResultをChat Completions形式へ変換する", () => {
    const request: ProviderRequest = {
      ...baseRequest,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect" },
            { type: "image", mediaType: "image/png", data: "abc" },
          ],
        },
        {
          role: "assistant",
          content: [],
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { key: "x" } }],
        },
        { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "result" }] },
      ],
      tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
      options: { maxOutputTokens: 200, temperature: 0.2 },
    };

    expect(
      toChatCompletionsRequest(request, {
        systemRole: "developer",
        maxTokensField: "max_completion_tokens",
        parallelToolCalls: "include",
        streamUsage: "include",
      }),
    ).toEqual({
      model: "model-test",
      messages: [
        { role: "developer", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "result" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", description: "Look up", parameters: { type: "object" } },
        },
      ],
      stream: true,
      n: 1,
      temperature: 0.2,
      max_completion_tokens: 200,
      parallel_tool_calls: true,
      stream_options: { include_usage: true },
    });
  });

  it("Text、Usage、Stop Reasonを共通イベントへ正規化する", async () => {
    const adapter = createAdapter(
      fakeFetch([
        sse({ choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }] }),
        sse({ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
        "data: [DONE]\n\n",
      ]),
    );

    await expect(collect(adapter)).resolves.toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
      { type: "completed", stopReason: "end-turn" },
    ]);
  });

  it("単一・並列Tool Callの断片をIndex単位で安全に結合する", async () => {
    const adapter = createAdapter(
      fakeFetch([
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: "" },
                  },
                  {
                    index: 1,
                    id: "call-2",
                    type: "function",
                    function: { name: "lookup", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"key":' } }] },
              finish_reason: null,
            },
          ],
        }),
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 1, function: { arguments: '{"key":"y"}' } }] },
              finish_reason: null,
            },
          ],
        }),
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
              finish_reason: null,
            },
          ],
        }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
      {},
    );

    await expect(
      collect(adapter, undefined, { ...baseRequest, tools: [{ name: "lookup", inputSchema: {} }] }),
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

  it("Object引数はProfileで許可した場合だけ受け付ける", async () => {
    const adapter = createAdapter(
      fakeFetch([
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call-1", function: { name: "lookup", arguments: { key: "x" } } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
      { profile: { toolArguments: "object" } },
    );

    await expect(
      collect(adapter, undefined, { ...baseRequest, tools: [{ name: "lookup", inputSchema: {} }] }),
    ).resolves.toEqual([
      { type: "tool-call-start", id: "call-1", name: "lookup" },
      { type: "tool-call", id: "call-1", name: "lookup", arguments: { key: "x" } },
      { type: "completed", stopReason: "tool-call" },
    ]);
  });

  it("不完全なTool CallではCompletedを発行しない", async () => {
    const adapter = createAdapter(
      fakeFetch([
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call-1", function: { name: "lookup", arguments: "{" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
      {},
    );

    const events = await collect(adapter, undefined, {
      ...baseRequest,
      tools: [{ name: "lookup", inputSchema: {} }],
    });
    expect(events).toEqual([
      { type: "tool-call-start", id: "call-1", name: "lookup" },
      { type: "tool-call-delta", id: "call-1", argumentsDelta: "{" },
      { type: "error", error: expect.objectContaining({ code: "bad-request", retryable: false }) },
    ]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("HTTPエラーとRetry-Afterを分類する", async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        }),
    ) as unknown as typeof fetch;
    const adapter = createAdapter(fetchImpl);

    await expect(collect(adapter)).resolves.toEqual([
      {
        type: "error",
        error: expect.objectContaining({ code: "rate-limited", retryAfterMs: 2000, status: 429 }),
      },
    ]);
  });

  it("SSE Errorの後にCompletedを発行しない", async () => {
    const adapter = createAdapter(
      fakeFetch(['event: error\ndata: {"error":{"code":"server_error","message":"secret"}}\n\n']),
    );

    await expect(collect(adapter)).resolves.toEqual([
      { type: "error", error: expect.objectContaining({ code: "unknown", retryable: false }) },
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

function createAdapter(
  fetchImpl: typeof fetch,
  options: OpenAIChatCompletionsAdapterOptions = {},
): OpenAIChatCompletionsAdapter {
  return new OpenAIChatCompletionsAdapter(
    {
      providerId: "provider-test",
      vendor: "test",
      apiType: "chat-completions",
      url: "https://provider.example.test/v1/chat/completions",
      headers: {},
      credential: "secret-key",
    },
    { fetchImpl, ...options },
  );
}

async function collect(
  adapter: OpenAIChatCompletionsAdapter,
  signal = new AbortController().signal,
  request: ProviderRequest = baseRequest,
) {
  const events = [];
  for await (const event of adapter.stream(request, signal)) events.push(event);
  return events;
}

function fakeFetch(chunks: readonly string[]): typeof fetch {
  return vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
