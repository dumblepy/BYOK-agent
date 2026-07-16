import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderEvent } from "../../src/providers/provider-types";
import {
  defaultRequest,
  type ProviderContractCase,
  type ProviderContractFixture,
} from "./adapter-harness";

export function openAIResponsesContractCases(): readonly ProviderContractCase[] {
  return [
    {
      id: "TextとUsageを正規化しCompletedを終端にする",
      request: defaultRequest(),
      fixture: loadFixture("openai-responses", "text-usage.sse"),
      expected: [
        { type: "text-delta", text: "hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", inputTokens: 12, outputTokens: 4, cachedTokens: 2, reasoningTokens: 1 },
        { type: "completed", stopReason: "end-turn" },
      ],
    },
    {
      id: "Tool Callの断片をCall ID単位で確定する",
      request: toolRequest(),
      fixture: loadFixture("openai-responses", "tool-call.sse"),
      expected: toolEvents(),
    },
    {
      id: "Provider Error後にCompletedを発行しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-responses", "error.sse"),
      expectedError: { code: "bad-request", retryable: false },
    },
    {
      id: "開始前Cancelでは通信を開始しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-responses", "text-usage.sse"),
      abort: "before-request",
    },
    {
      id: "ストリーム中Cancel後に後続イベントを発行しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-responses", "text-usage.sse"),
      abort: "during-stream",
    },
  ];
}

export function openAIChatCompletionsContractCases(): readonly ProviderContractCase[] {
  return [
    {
      id: "TextとUsageを正規化しCompletedを終端にする",
      request: defaultRequest(),
      fixture: loadFixture("openai-chat-completions", "text-usage.sse"),
      expected: [
        { type: "text-delta", text: "hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", inputTokens: 12, outputTokens: 4 },
        { type: "completed", stopReason: "end-turn" },
      ],
    },
    {
      id: "Tool Callの断片をCall ID単位で確定する",
      request: toolRequest(),
      fixture: loadFixture("openai-chat-completions", "tool-call.sse"),
      expected: toolEvents(),
    },
    {
      id: "Provider Error後にCompletedを発行しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-chat-completions", "error.sse"),
      expectedError: { code: "bad-request", retryable: false },
    },
    {
      id: "開始前Cancelでは通信を開始しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-chat-completions", "text-usage.sse"),
      abort: "before-request",
    },
    {
      id: "ストリーム中Cancel後に後続イベントを発行しない",
      request: defaultRequest(),
      fixture: loadFixture("openai-chat-completions", "text-usage.sse"),
      abort: "during-stream",
    },
  ];
}

function toolRequest() {
  return defaultRequest({
    tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
  });
}

function toolEvents(): readonly ProviderEvent[] {
  return [
    { type: "tool-call-start", id: "call-1", name: "lookup" },
    { type: "tool-call-delta", id: "call-1", argumentsDelta: '{"key":' },
    { type: "tool-call-delta", id: "call-1", argumentsDelta: '"x"}' },
    { type: "tool-call", id: "call-1", name: "lookup", arguments: { key: "x" } },
    { type: "completed", stopReason: "tool-call" },
  ];
}

function loadFixture(provider: string, file: string): ProviderContractFixture {
  const contents = readFileSync(join(__dirname, "fixtures", provider, file), "utf8");
  const chunks = contents
    .split(/\r?\n\r?\n/)
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => `${chunk}\n\n`);
  return { chunks };
}
