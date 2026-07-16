import { describe, expect, it, vi } from "vitest";

import { ConfiguredModelCatalog } from "../../src/models/model-catalog";
import {
  DefaultProviderRouter,
  InMemoryProviderAdapterRegistry,
  type ProviderAdapterFactory,
} from "../../src/providers/provider-router";
import type { ProviderAdapter, ProviderRequest } from "../../src/providers/provider-types";

const config = [
  {
    name: "Test Provider",
    vendor: "test",
    apiType: "responses" as const,
    models: [
      {
        id: "test-model",
        name: "Test Model",
        url: "https://provider.example.test/responses",
        toolCalling: true,
        vision: false,
        maxInputTokens: 1024,
        maxOutputTokens: 128,
      },
    ],
  },
];

const request: ProviderRequest = {
  requestId: "extension-integration",
  modelId: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

describe("Provider Router Extension Host経路", () => {
  it("Configured Model CatalogからAdapter呼び出しまで解決する", async () => {
    const adapter: ProviderAdapter = {
      type: "fake-responses",
      async *stream(received) {
        expect(received.modelId).toBe("test-model");
        yield { type: "text-delta", text: "ok" };
        yield { type: "completed", stopReason: "end-turn" };
      },
    };
    const factory: ProviderAdapterFactory = {
      apiType: "responses",
      create: vi.fn(async (input) => {
        expect(input.providerId).toBe("Test Provider");
        expect(input.credential).toBe("host-secret");
        return adapter;
      }),
    };
    const router = new DefaultProviderRouter({
      catalog: new ConfiguredModelCatalog(config),
      registry: new InMemoryProviderAdapterRegistry([factory]),
      credentials: { getApiKey: vi.fn(async () => "host-secret") },
    });

    const events = [];
    for await (const event of router.stream("test-model", request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "completed", stopReason: "end-turn" },
    ]);
    expect(factory.create).toHaveBeenCalledTimes(1);
    await router.dispose();
  });
});
