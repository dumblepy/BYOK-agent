import { describe, expect, it } from "vitest";

import { OpenAIChatCompletionsAdapter } from "../../../src/providers/openai/openai-chat-completions-adapter";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai/openai-responses-adapter";
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../../src/providers/provider-types";

interface LiveContractConfig {
  readonly provider: "responses" | "chat-completions";
  readonly url: string;
  readonly apiKey: string;
  readonly modelId: string;
}

const config = readLiveConfig();

describe.skipIf(config === undefined)("Provider Contract実APIテスト", () => {
  it("固定Text要求が共通イベント契約を満たす", async () => {
    if (config === undefined) return;
    const adapter = createAdapter(config);
    const events: ProviderEvent[] = [];
    for await (const event of adapter.stream(
      createRequest(config.modelId),
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    const terminals = events.filter(
      (event) => event.type === "completed" || event.type === "error" || event.type === "cancelled",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual(events[events.length - 1]);
    expect(JSON.stringify(events)).not.toContain(config.apiKey);
  }, 120_000);
});

function readLiveConfig(): LiveContractConfig | undefined {
  if (process.env.BYOK_PROVIDER_CONTRACT_LIVE !== "1") return undefined;
  const provider = process.env.BYOK_PROVIDER_CONTRACT_LIVE_PROVIDER;
  const url = process.env.BYOK_PROVIDER_CONTRACT_LIVE_URL;
  const apiKey = process.env.BYOK_PROVIDER_CONTRACT_LIVE_API_KEY;
  const modelId = process.env.BYOK_PROVIDER_CONTRACT_LIVE_MODEL;
  if (
    (provider !== "responses" && provider !== "chat-completions") ||
    !url ||
    !apiKey ||
    !modelId
  ) {
    throw new Error(
      "実API Contract TestにはBYOK_PROVIDER_CONTRACT_LIVE=1、Provider、URL、APIキー、モデルIDが必要です。",
    );
  }
  return { provider, url, apiKey, modelId };
}

function createAdapter(config: LiveContractConfig): ProviderAdapter {
  const init = {
    providerId: "live-contract",
    vendor: "live",
    apiType: config.provider,
    url: config.url,
    headers: {},
    credential: config.apiKey,
  } as const;
  return config.provider === "responses"
    ? new OpenAIResponsesAdapter(init)
    : new OpenAIChatCompletionsAdapter(init);
}

function createRequest(modelId: string): ProviderRequest {
  return {
    requestId: "live-contract-request",
    modelId,
    messages: [
      { role: "user", content: [{ type: "text", text: "Reply with the single word: hello" }] },
    ],
    tools: [],
    options: { maxOutputTokens: 16 },
  };
}
