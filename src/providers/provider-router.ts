import type { ApiType } from "../models/model-config-validator";
import type { ModelCatalog, ModelDefinition } from "../models/model-catalog";
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  TokenCountInput,
} from "./provider-types";
import type { ChatCompletionsProfile } from "./openai/openai-chat-completions-types";

export interface ProviderCredentialResolver {
  getApiKey(providerId: string): Promise<string | undefined>;
  getCredentialRevision?(providerId: string): number;
}

export interface ProviderAdapterInit {
  readonly providerId: string;
  readonly vendor: string;
  readonly apiType: ApiType;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Secret values are confined to this initialization boundary. */
  readonly credential?: string;
  /** Provider-specific behavior is finite, validated configuration, never arbitrary request JSON. */
  readonly chatCompletionsProfile?: Partial<ChatCompletionsProfile>;
}

export interface ProviderAdapterFactory {
  readonly apiType: ApiType;
  create(input: ProviderAdapterInit): Promise<ProviderAdapter>;
}

export interface ProviderAdapterRegistry {
  get(apiType: ApiType): ProviderAdapterFactory | undefined;
  register(factory: ProviderAdapterFactory): void;
  unregister(apiType: ApiType): boolean;
}

export class InMemoryProviderAdapterRegistry implements ProviderAdapterRegistry {
  private readonly factories = new Map<ApiType, ProviderAdapterFactory>();

  public constructor(factories: readonly ProviderAdapterFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  public get(apiType: ApiType): ProviderAdapterFactory | undefined {
    return this.factories.get(apiType);
  }

  public register(factory: ProviderAdapterFactory): void {
    if (!factory || !factory.apiType) throw new Error("Provider Adapter Factoryが不正です。");
    this.factories.set(factory.apiType, factory);
  }

  public unregister(apiType: ApiType): boolean {
    return this.factories.delete(apiType);
  }
}

export type ProviderRouterErrorCode =
  | "model-not-found"
  | "adapter-not-registered"
  | "provider-initialization-failed"
  | "credential-unavailable"
  | "request-model-mismatch"
  | "router-disposed";

const ROUTER_MESSAGES: Readonly<Record<ProviderRouterErrorCode, string>> = {
  "model-not-found": "指定されたモデルは利用できません。",
  "adapter-not-registered": "モデルに対応するProvider Adapterが登録されていません。",
  "provider-initialization-failed": "Providerの初期化に失敗しました。",
  "credential-unavailable": "Providerの認証情報が設定されていません。",
  "request-model-mismatch": "Providerリクエストのモデル識別子が一致しません。",
  "router-disposed": "Provider Routerは終了しています。",
};

export class ProviderRouterError extends Error {
  public readonly name = "ProviderRouterError";
  public readonly retryable = false;

  public constructor(
    public readonly code: ProviderRouterErrorCode,
    public readonly modelId?: string,
    public readonly providerId?: string,
  ) {
    super(ROUTER_MESSAGES[code]);
  }
}

export interface ProviderRouter {
  stream(
    modelId: string,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
  countTokens(modelId: string, input: TokenCountInput, signal?: AbortSignal): Promise<number>;
  dispose(): Promise<void>;
}

export interface ProviderRouterDependencies {
  readonly catalog: ModelCatalog;
  readonly registry: ProviderAdapterRegistry;
  readonly credentials: ProviderCredentialResolver;
}

interface CachedAdapter {
  readonly key: string;
  readonly providerId: string;
  readonly adapter: ProviderAdapter;
  references: number;
}

/** Resolves catalog models to reusable, provider-specific adapters. */
export class DefaultProviderRouter implements ProviderRouter {
  private readonly adapters = new Map<string, CachedAdapter>();
  private readonly initializations = new Map<string, Promise<CachedAdapter>>();
  private readonly activeControllers = new Set<AbortController>();
  private disposed = false;

  public constructor(private readonly dependencies: ProviderRouterDependencies) {}

  public stream(
    modelId: string,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    return this.streamInternal(modelId, request, signal);
  }

  private async *streamInternal(
    modelId: string,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const resolved = await this.resolveAdapter(modelId, request.modelId);
    const controller = new AbortController();
    const removeAbortListener = forwardAbort(signal, controller);
    this.activeControllers.add(controller);
    resolved.references += 1;
    try {
      for await (const event of resolved.adapter.stream(request, controller.signal)) {
        if (controller.signal.aborted) break;
        yield event;
      }
    } finally {
      removeAbortListener();
      this.activeControllers.delete(controller);
      resolved.references -= 1;
      await this.releaseAdapter(resolved);
    }
  }

  public async countTokens(
    modelId: string,
    input: TokenCountInput,
    signal = new AbortController().signal,
  ): Promise<number> {
    const resolved = await this.resolveAdapter(modelId, input.modelId);
    if (!resolved.adapter.countTokens) {
      throw new ProviderRouterError("adapter-not-registered", modelId, resolved.providerId);
    }
    resolved.references += 1;
    try {
      return await resolved.adapter.countTokens(input, signal);
    } finally {
      resolved.references -= 1;
      await this.releaseAdapter(resolved);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort();
    await Promise.all(
      [...this.initializations].map(([, initialization]) => initialization.catch(() => undefined)),
    );
    const cached = [...this.adapters.values()];
    this.adapters.clear();
    this.initializations.clear();
    await Promise.all(cached.map(({ adapter }) => disposeAdapter(adapter)));
  }

  private async resolveAdapter(
    requestedModelId: string,
    requestModelId: string,
  ): Promise<CachedAdapter> {
    this.assertActive();
    if (requestedModelId !== requestModelId) {
      throw new ProviderRouterError("request-model-mismatch", requestedModelId);
    }
    const model = this.dependencies.catalog.resolve(requestedModelId);
    if (!model) throw new ProviderRouterError("model-not-found", requestedModelId);
    const factory = this.dependencies.registry.get(model.provider.apiType);
    if (!factory) {
      throw new ProviderRouterError("adapter-not-registered", model.id, model.provider.id);
    }

    let credential: string | undefined;
    try {
      credential = await this.dependencies.credentials.getApiKey(model.provider.id);
    } catch {
      throw new ProviderRouterError("credential-unavailable", model.id, model.provider.id);
    }
    if (!credential) {
      throw new ProviderRouterError("credential-unavailable", model.id, model.provider.id);
    }

    const key = createAdapterKey(
      model,
      this.dependencies.catalog.getRevision(),
      this.dependencies.credentials.getCredentialRevision?.(model.provider.id) ?? 0,
    );
    const cached = this.adapters.get(key);
    if (cached) return cached;
    const pending = this.initializations.get(key);
    if (pending) return pending;

    const initialization = this.createAdapter(key, model, factory, credential);
    this.initializations.set(key, initialization);
    try {
      const resolved = await initialization;
      this.adapters.set(key, resolved);
      return resolved;
    } finally {
      this.initializations.delete(key);
    }
  }

  private async createAdapter(
    key: string,
    model: ModelDefinition,
    factory: ProviderAdapterFactory,
    credential: string,
  ): Promise<CachedAdapter> {
    try {
      return {
        key,
        providerId: model.provider.id,
        adapter: await factory.create({
          providerId: model.provider.id,
          vendor: model.provider.vendor,
          apiType: model.provider.apiType,
          url: model.provider.url,
          headers: model.provider.headers,
          credential,
          chatCompletionsProfile: model.provider.chatCompletionsProfile,
        }),
        references: 0,
      };
    } catch {
      throw new ProviderRouterError("provider-initialization-failed", model.id, model.provider.id);
    }
  }

  private async releaseAdapter(cached: CachedAdapter): Promise<void> {
    if (cached.references > 0 || this.adapters.get(cached.key) !== cached) return;
    // Keep initialized adapters reusable. They are disposed together with the Router.
  }

  private assertActive(): void {
    if (this.disposed) throw new ProviderRouterError("router-disposed");
  }
}

function createAdapterKey(
  model: ModelDefinition,
  catalogRevision: number,
  credentialRevision: number,
): string {
  const headers = Object.entries(model.provider.headers).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify([
    catalogRevision,
    model.provider.id,
    model.provider.apiType,
    model.provider.url,
    headers,
    model.provider.chatCompletionsProfile ?? null,
    credentialRevision,
  ]);
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort();
  if (source.aborted) target.abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function disposeAdapter(adapter: ProviderAdapter): Promise<void> {
  await adapter.dispose?.();
}
