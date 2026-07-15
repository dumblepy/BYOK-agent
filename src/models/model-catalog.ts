import type {
  AgentSettings,
  ApiType,
  ModelCapabilities,
  ModelConfig,
  ModelConfigModel,
  ModelConfigProvider,
  ReasoningEffort,
} from "./model-config-validator";

export type CapabilityName = "toolCalling" | "streaming" | "vision" | "reasoning";

export interface EffectiveCapabilities {
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly revision: number;
}

export interface CapabilityResolution {
  readonly configured: ModelCapabilities;
  readonly effective: EffectiveCapabilities;
  readonly disabledReasons: Readonly<Partial<Record<CapabilityName, string>>>;
}

export interface ModelCatalogChangeSubscription {
  dispose(): void;
}

export interface ResolvedAgentSettings {
  readonly promptProfile: string;
  readonly contextProfile: "compact" | "balanced" | "extended";
  readonly toolProfile: "read-only" | "workspace" | "full";
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxConsecutiveFailures: number;
}

export interface ResolvedProviderSettings {
  readonly id: string;
  readonly vendor: string;
  readonly apiType: ApiType;
  readonly url: string;
  readonly secretRef?: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly provider: ResolvedProviderSettings;
  readonly capabilities: ModelCapabilities;
  readonly effectiveCapabilities: EffectiveCapabilities;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly agent: ResolvedAgentSettings;
}

export interface ModelCatalogEntry extends ModelDefinition {
  readonly available?: boolean;
}

export type ModelCatalogDiagnosticCode =
  | "MODEL_DUPLICATE_ID"
  | "MODEL_PROVIDER_NOT_FOUND"
  | "MODEL_ADAPTER_UNSUPPORTED"
  | "MODEL_CAPABILITY_ADAPTER_UNSUPPORTED"
  | "MODEL_SECRET_UNAVAILABLE"
  | "MODEL_NOT_AVAILABLE"
  | "MODEL_DEFAULT_INVALID";

export interface ModelCatalogDiagnostic {
  readonly source?: string;
  readonly path: string;
  readonly code: ModelCatalogDiagnosticCode;
  readonly severity: "warning" | "error";
  readonly userMessage: string;
}

export interface ModelCatalog {
  listAvailable(): readonly ModelCatalogEntry[];
  findAvailable(modelId: string): ModelCatalogEntry | undefined;
  resolve(modelId: string): ModelDefinition | undefined;
  getDefault(): ModelDefinition | undefined;
  diagnostics(): readonly ModelCatalogDiagnostic[];
  onDidChange?(listener: () => void): ModelCatalogChangeSubscription;
}

export interface ConfiguredModelCatalogOptions {
  readonly supportedApiTypes?: readonly ApiType[];
  readonly hasSecret?: (secretRef: string) => boolean;
  readonly defaultModelId?: string;
  readonly adapterCapabilities?: Partial<Record<CapabilityName, boolean>>;
}

const DEFAULT_AGENT_SETTINGS: ResolvedAgentSettings = {
  promptProfile: "default",
  contextProfile: "balanced",
  toolProfile: "read-only",
  maxIterations: 20,
  maxToolCalls: 100,
  maxConsecutiveFailures: 3,
};

export class ConfiguredModelCatalog implements ModelCatalog {
  private entries: readonly ModelCatalogEntry[] = [];
  private invalidEntries: readonly ModelCatalogDiagnostic[] = [];
  private configuredDefaultModelId: string | undefined;
  private revision = 0;
  private readonly changeListeners = new Set<() => void>();

  public constructor(
    config?: ModelConfig,
    private readonly options: ConfiguredModelCatalogOptions = {},
  ) {
    if (config) this.replace(config);
  }

  public replace(config: ModelConfig, defaultModelId = this.options.defaultModelId): void {
    const entries: ModelCatalogEntry[] = [];
    const diagnostics: ModelCatalogDiagnostic[] = [];
    const seen = new Set<string>();

    config.forEach((provider, providerIndex) => {
      provider.models.forEach((model, modelIndex) => {
        const path = `/${providerIndex}/models/${modelIndex}`;
        if (seen.has(model.id)) {
          diagnostics.push(
            diagnostic(path, "MODEL_DUPLICATE_ID", "同じModel IDが複数定義されています。"),
          );
          return;
        }
        seen.add(model.id);
        const entry = this.createEntry(provider, model, path, diagnostics);
        if (entry) entries.push(entry);
      });
    });

    this.entries = Object.freeze(entries);
    this.invalidEntries = Object.freeze(diagnostics);
    this.configuredDefaultModelId = defaultModelId;
    this.revision += 1;
    for (const listener of this.changeListeners) listener();
  }

  public onDidChange(listener: () => void): ModelCatalogChangeSubscription {
    this.changeListeners.add(listener);
    return {
      dispose: () => this.changeListeners.delete(listener),
    };
  }

  public listAvailable(): readonly ModelCatalogEntry[] {
    return [...this.entries].filter((entry) => entry.available !== false).sort(compareEntries);
  }

  public findAvailable(modelId: string): ModelCatalogEntry | undefined {
    return this.listAvailable().find((entry) => entry.id === modelId);
  }

  public resolve(modelId: string): ModelDefinition | undefined {
    return this.findAvailable(modelId);
  }

  public getDefault(): ModelDefinition | undefined {
    if (this.configuredDefaultModelId !== undefined) {
      return this.resolve(this.configuredDefaultModelId);
    }
    return this.listAvailable()[0];
  }

  public diagnostics(): readonly ModelCatalogDiagnostic[] {
    const diagnostics = [...this.invalidEntries];
    if (
      this.configuredDefaultModelId !== undefined &&
      !this.resolve(this.configuredDefaultModelId)
    ) {
      diagnostics.push(
        diagnostic(
          "/defaultModelId",
          "MODEL_DEFAULT_INVALID",
          "指定された既定モデルは利用できません。",
        ),
      );
    }
    return diagnostics;
  }

  private createEntry(
    provider: ModelConfigProvider,
    model: ModelConfigModel,
    path: string,
    diagnostics: ModelCatalogDiagnostic[],
  ): ModelCatalogEntry | undefined {
    if (
      this.options.supportedApiTypes &&
      !this.options.supportedApiTypes.includes(provider.apiType)
    ) {
      diagnostics.push(
        diagnostic(
          `${path}/apiType`,
          "MODEL_ADAPTER_UNSUPPORTED",
          "対応するProvider Adapterがありません。",
        ),
      );
      return undefined;
    }
    if (provider.apiKey && this.options.hasSecret && !this.options.hasSecret(provider.apiKey)) {
      diagnostics.push(
        diagnostic(
          `${path}/apiKey`,
          "MODEL_SECRET_UNAVAILABLE",
          "ProviderのSecretを利用できません。",
        ),
      );
      return undefined;
    }

    const capabilityResolution = createCapabilities(
      model,
      this.options.adapterCapabilities,
      this.revision + 1,
    );
    const capabilityNames: readonly CapabilityName[] = [
      "toolCalling",
      "streaming",
      "vision",
      "reasoning",
    ];
    for (const capability of capabilityNames) {
      if (
        capabilityResolution.configured[capability] &&
        this.options.adapterCapabilities?.[capability] === false
      ) {
        diagnostics.push(
          diagnostic(
            `${path}/${capability}`,
            "MODEL_CAPABILITY_ADAPTER_UNSUPPORTED",
            "Provider Adapterがこのモデルの能力に対応していません。",
          ),
        );
      }
    }

    return Object.freeze({
      id: model.id,
      label: model.name,
      provider: Object.freeze({
        id: provider.name,
        vendor: provider.vendor,
        apiType: provider.apiType,
        url: model.url,
        ...(provider.apiKey ? { secretRef: provider.apiKey } : {}),
        headers: Object.freeze({ ...(provider.headers ?? {}) }),
      }),
      capabilities: capabilityResolution.configured,
      effectiveCapabilities: capabilityResolution.effective,
      contextWindow: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      agent: resolveAgentSettings(model.agent),
    });
  }
}

/** Compatibility catalog for existing UI-only callers. */
export class StaticModelCatalog implements ModelCatalog {
  private readonly entries: readonly ModelCatalogEntry[];

  public constructor(entries: readonly LegacyModelCatalogEntry[] = DEFAULT_MODEL_CATALOG) {
    this.entries = Object.freeze(
      entries
        .filter(
          (entry) =>
            entry.id.length > 0 && entry.label.trim().length > 0 && entry.provider.length > 0,
        )
        .map((entry) =>
          Object.freeze({
            id: entry.id,
            label: entry.label,
            provider: Object.freeze({
              id: entry.provider,
              vendor: entry.provider,
              apiType: "responses" as const,
              url: "https://localhost.invalid",
              headers: Object.freeze({}),
            }),
            capabilities: Object.freeze({
              toolCalling: false,
              streaming: false,
              vision: false,
              reasoning: false,
              reasoningEfforts: [],
            }),
            effectiveCapabilities: Object.freeze({
              toolCalling: false,
              streaming: false,
              vision: false,
              reasoning: false,
              reasoningEfforts: [],
              revision: 0,
            }),
            contextWindow: 1024,
            maxOutputTokens: 1,
            agent: DEFAULT_AGENT_SETTINGS,
          }),
        ),
    );
  }

  public listAvailable(): readonly ModelCatalogEntry[] {
    return [...this.entries].sort(compareEntries);
  }

  public findAvailable(modelId: string): ModelCatalogEntry | undefined {
    return this.listAvailable().find((entry) => entry.id === modelId);
  }

  public resolve(modelId: string): ModelDefinition | undefined {
    return this.findAvailable(modelId);
  }

  public getDefault(): ModelDefinition | undefined {
    return this.listAvailable()[0];
  }

  public diagnostics(): readonly ModelCatalogDiagnostic[] {
    return [];
  }
}

export interface LegacyModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
}

export const DEFAULT_MODEL_CATALOG: readonly LegacyModelCatalogEntry[] = [
  { id: "coding-primary", label: "Coding Primary", provider: "primary-openai" },
  { id: "coding-fast", label: "Coding Fast", provider: "primary-openai" },
];

function resolveAgentSettings(settings?: AgentSettings): ResolvedAgentSettings {
  return {
    promptProfile: settings?.promptProfile ?? DEFAULT_AGENT_SETTINGS.promptProfile,
    contextProfile: settings?.contextProfile ?? DEFAULT_AGENT_SETTINGS.contextProfile,
    toolProfile: settings?.toolProfile ?? DEFAULT_AGENT_SETTINGS.toolProfile,
    maxIterations: settings?.maxIterations ?? DEFAULT_AGENT_SETTINGS.maxIterations,
    maxToolCalls: settings?.maxToolCalls ?? DEFAULT_AGENT_SETTINGS.maxToolCalls,
    maxConsecutiveFailures:
      settings?.maxConsecutiveFailures ?? DEFAULT_AGENT_SETTINGS.maxConsecutiveFailures,
  };
}

function diagnostic(
  path: string,
  code: ModelCatalogDiagnosticCode,
  userMessage: string,
): ModelCatalogDiagnostic {
  return { path, code, severity: "error", userMessage };
}

function compareEntries(left: ModelCatalogEntry, right: ModelCatalogEntry): number {
  return (
    left.label.localeCompare(right.label) ||
    left.provider.id.localeCompare(right.provider.id) ||
    left.id.localeCompare(right.id)
  );
}

function createCapabilities(
  model: ModelConfigModel,
  adapterCapabilities: Partial<Record<CapabilityName, boolean>> | undefined,
  revision: number,
): CapabilityResolution {
  const reasoning = model.reasoning ?? model.thinking ?? false;
  const reasoningEfforts = [...(model.reasoningEfforts ?? model.supportsReasoningEffort ?? [])];
  const capabilities: ModelCapabilities = Object.freeze({
    toolCalling: model.toolCalling,
    streaming: model.streaming ?? false,
    vision: model.vision,
    reasoning,
    reasoningEfforts: Object.freeze(reasoningEfforts),
    // Keep legacy fields on the resolved object for consumers that have not migrated yet.
    thinking: reasoning,
    supportsReasoningEffort: Object.freeze(reasoningEfforts),
  });
  const configured: Record<CapabilityName, boolean> = {
    toolCalling: capabilities.toolCalling,
    streaming: capabilities.streaming,
    vision: capabilities.vision,
    reasoning: capabilities.reasoning,
  };
  const effective = Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name,
      value && (adapterCapabilities?.[name as CapabilityName] ?? true),
    ]),
  ) as Record<CapabilityName, boolean>;
  const effectiveReasoningEfforts = effective.reasoning ? reasoningEfforts : [];
  const disabledReasons = Object.fromEntries(
    Object.entries(configured)
      .filter(([name, value]) => value && adapterCapabilities?.[name as CapabilityName] === false)
      .map(([name]) => [name, "Provider Adapterがこの能力に対応していません。"]),
  ) as Partial<Record<CapabilityName, string>>;
  return {
    configured: capabilities,
    effective: Object.freeze({
      ...effective,
      reasoningEfforts: Object.freeze(effectiveReasoningEfforts),
      revision,
    }),
    disabledReasons: Object.freeze(disabledReasons),
  };
}
