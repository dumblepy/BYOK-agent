import { describe, expect, it, vi } from "vitest";

import { StaticModelCatalog } from "../../src/models/model-catalog";
import {
  DefaultProviderRouter,
  InMemoryProviderAdapterRegistry,
  ProviderRouterError,
  type ProviderAdapterFactory,
} from "../../src/providers/provider-router";
import type { ProviderAdapter, ProviderRequest } from "../../src/providers/provider-types";

const request: ProviderRequest = {
  requestId: "router-test",
  modelId: "coding-primary",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

function factory(
  adapter: ProviderAdapter,
  apiType: ProviderAdapterFactory["apiType"] = "responses",
) {
  return { apiType, create: vi.fn(async () => adapter) } satisfies ProviderAdapterFactory;
}

function credentials() {
  return { getApiKey: vi.fn(async () => "test-secret"), getCredentialRevision: vi.fn(() => 0) };
}

async function collect(router: DefaultProviderRouter) {
  const events = [];
  for await (const event of router.stream(request.modelId, request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("DefaultProviderRouter", () => {
  it("Model IDからapiTypeに対応するAdapterへ委譲する", async () => {
    const adapter: ProviderAdapter = {
      type: "fake",
      async *stream(received) {
        expect(received.modelId).toBe(request.modelId);
        yield { type: "completed", stopReason: "end-turn" };
      },
    };
    const registered = factory(adapter);
    const router = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry([registered]),
      credentials: credentials(),
    });

    await expect(collect(router)).resolves.toEqual([{ type: "completed", stopReason: "end-turn" }]);
    expect(registered.create).toHaveBeenCalledTimes(1);
    await router.dispose();
  });

  it("同一Provider構成のAdapterを初期化・再利用する", async () => {
    const adapter: ProviderAdapter = { type: "fake", async *stream() {} };
    const registered = factory(adapter);
    const router = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry([registered]),
      credentials: credentials(),
    });

    await Promise.all([collect(router), collect(router)]);
    expect(registered.create).toHaveBeenCalledTimes(1);
    await router.dispose();
  });

  it("Adapter未登録を構造化エラーにする", async () => {
    const router = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry(),
      credentials: credentials(),
    });

    await expect(collect(router)).rejects.toMatchObject<Partial<ProviderRouterError>>({
      code: "adapter-not-registered",
      retryable: false,
    });
    await router.dispose();
  });

  it("Model未解決と認証情報未設定を区別する", async () => {
    const adapter: ProviderAdapter = { type: "fake", async *stream() {} };
    const registered = factory(adapter);
    const missingModelRouter = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry([registered]),
      credentials: credentials(),
    });
    const missingModelRequest = { ...request, modelId: "missing" };
    await expect(
      (async () => {
        for await (const event of missingModelRouter.stream(
          "missing",
          missingModelRequest,
          new AbortController().signal,
        )) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({ code: "model-not-found" });
    await missingModelRouter.dispose();

    const unavailable = credentials();
    unavailable.getApiKey.mockResolvedValue(undefined);
    const missingCredentialRouter = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry([registered]),
      credentials: unavailable,
    });
    await expect(collect(missingCredentialRouter)).rejects.toMatchObject({
      code: "credential-unavailable",
    });
    await missingCredentialRouter.dispose();
  });

  it("Credential revisionが変わると新しいAdapterを初期化する", async () => {
    const adapter: ProviderAdapter = { type: "fake", async *stream() {} };
    const registered = factory(adapter);
    let revision = 0;
    const credentialResolver = {
      getApiKey: vi.fn(async () => "secret"),
      getCredentialRevision: () => revision,
    };
    const router = new DefaultProviderRouter({
      catalog: new StaticModelCatalog(),
      registry: new InMemoryProviderAdapterRegistry([registered]),
      credentials: credentialResolver,
    });

    await collect(router);
    revision = 1;
    await collect(router);
    expect(registered.create).toHaveBeenCalledTimes(2);
    await router.dispose();
  });
});
