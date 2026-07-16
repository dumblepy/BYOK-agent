import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";

import { DefaultAgentService, type AgentService } from "../agent/agent-service";
import { DefaultProviderService, type ProviderService } from "../providers/provider-service";
import { DefaultStorageService, type StorageService } from "../storage/storage-service";
import { DefaultUIService, type UIService, type UIServiceDependencies } from "../ui/ui-service";
import { type ApplicationService, disposeInReverse } from "./service-lifecycle";
import type { ModelCatalog } from "../models/model-catalog";
import type { DiagnosticLogger } from "../observability/diagnostic-logger";

export interface ApplicationServices {
  readonly provider: ProviderService;
  readonly storage: StorageService;
  readonly agent: AgentService;
  readonly ui: UIService;
  dispose(): Promise<void>;
}

export interface ApplicationServiceFactories {
  readonly provider: (context: ExtensionContext) => ProviderService;
  readonly storage: (context: ExtensionContext) => StorageService;
  readonly agent: (dependencies: {
    readonly provider: ProviderService;
    readonly storage: StorageService;
    readonly modelCatalog?: ModelCatalog;
  }) => AgentService;
  readonly ui: (dependencies: UIServiceDependencies) => UIService;
}

const defaultFactories: ApplicationServiceFactories = {
  provider: (context) =>
    new DefaultProviderService({
      secretStorage: context.secrets,
    }),
  storage: (context) =>
    new DefaultStorageService({
      globalStorageUri: context.globalStorageUri,
      artifactOptions: getGlobalArtifactOptions(),
    }),
  agent: (dependencies) => new DefaultAgentService(dependencies),
  ui: (dependencies) => new DefaultUIService(dependencies),
};

function getGlobalArtifactOptions(): NonNullable<
  ConstructorParameters<typeof DefaultStorageService>[0]["artifactOptions"]
> {
  const configuration = vscode.workspace.getConfiguration("byokAgent.artifacts");
  const inspectConfiguration = (
    configuration as unknown as {
      inspect?: <T>(key: string) => { readonly globalValue?: T } | undefined;
    }
  ).inspect;
  const inspect = <T>(key: string): T | undefined =>
    typeof inspectConfiguration === "function"
      ? inspectConfiguration<T>(key)?.globalValue
      : undefined;
  return {
    maxTotalBytes: inspect<number>("maxTotalBytes"),
    maxThreadBytes: inspect<number>("maxThreadBytes"),
    maxArtifactBytes: inspect<number>("maxArtifactBytes"),
    chunkBytes: inspect<number>("chunkBytes"),
    retentionDays: inspect<number>("retentionDays"),
    evictionPolicy: inspect<"oldest-first">("evictionPolicy"),
  };
}

class ApplicationServicesContainer implements ApplicationServices {
  private disposed = false;
  private disposalPromise: Promise<void> | undefined;

  public constructor(
    public readonly provider: ProviderService,
    public readonly storage: StorageService,
    public readonly agent: AgentService,
    public readonly ui: UIService,
  ) {}

  public dispose(): Promise<void> {
    if (this.disposed) {
      return this.disposalPromise ?? Promise.resolve();
    }

    this.disposed = true;
    this.disposalPromise = disposeInReverse([this.provider, this.storage, this.agent, this.ui]);
    return this.disposalPromise;
  }
}

async function disposeCreatedServices(services: readonly ApplicationService[]): Promise<void> {
  await disposeInReverse(services);
}

/** Creates and initializes all application services from one explicit dependency graph. */
export async function createApplicationServices(
  context: ExtensionContext,
  factories: ApplicationServiceFactories = defaultFactories,
  modelCatalog?: ModelCatalog,
  logger?: DiagnosticLogger,
): Promise<ApplicationServices> {
  const created: ApplicationService[] = [];

  try {
    const provider = factories.provider(context);
    created.push(provider);
    const storage = factories.storage(context);
    created.push(storage);

    await provider.initialize();
    await storage.initialize();

    const agent = factories.agent({ provider, storage, modelCatalog });
    created.push(agent);
    await agent.initialize();

    const ui = factories.ui({
      context,
      agent,
      storage,
      provider,
      modelCatalog,
      logger,
      registerWebviewViewProvider: (viewId, provider, options) =>
        vscode.window.registerWebviewViewProvider(viewId, provider, options),
    });
    created.push(ui);
    await ui.initialize();

    return new ApplicationServicesContainer(provider, storage, agent, ui);
  } catch (error) {
    try {
      await disposeCreatedServices(created);
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "Application service initialization and rollback both failed",
        { cause: disposeError },
      );
    }

    throw error;
  }
}
