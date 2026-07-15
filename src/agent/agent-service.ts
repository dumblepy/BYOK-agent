import { DisposableStore, ManagedService } from "../extension/service-lifecycle";
import type { ProviderService } from "../providers/provider-service";
import type { PermissionContext } from "../permissions/permission-profile";
import type { StorageService } from "../storage/storage-service";
import type { EffectiveCapabilities, ModelCatalog, ModelDefinition } from "../models/model-catalog";

export interface AgentRunRequest {
  readonly threadId: string;
  readonly text: string;
  readonly modelId: string;
  readonly model?: ModelDefinition;
  readonly effectiveCapabilities?: EffectiveCapabilities;
  readonly permissionContext: PermissionContext;
}

export interface AgentService extends ManagedService {
  readonly serviceName: "agent";
  hasActiveRun(threadId: string): boolean;
  prepareRunRequest(request: AgentRunRequest): Promise<AgentRunRequest>;
}

export interface AgentServiceDependencies {
  readonly provider: ProviderService;
  readonly storage: StorageService;
  readonly modelCatalog?: ModelCatalog;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly completion: PromiseLike<void>;
}

/** Lifecycle boundary for Agent Runtime. The Agent Loop is intentionally out of scope here. */
export class DefaultAgentService extends ManagedService implements AgentService {
  public readonly serviceName = "agent" as const;

  private readonly disposables = new DisposableStore();
  private readonly activeRuns = new Set<ActiveRun>();
  private acceptingRuns = false;

  public constructor(private readonly dependencies: AgentServiceDependencies) {
    super();
  }

  protected override onInitialize(): void {
    this.acceptingRuns = true;
    // Keep the dependency direction explicit without constructing either dependency here.
    void this.dependencies.provider;
    void this.dependencies.storage;
  }

  public registerActiveRun(controller: AbortController, completion: PromiseLike<void>): void {
    if (!this.acceptingRuns) {
      throw new Error("Agent service is not accepting runs");
    }

    const run = { controller, completion };
    this.activeRuns.add(run);
    void Promise.resolve(completion)
      .catch(() => undefined)
      .finally(() => this.activeRuns.delete(run));
  }

  public hasActiveRun(_threadId: string): boolean {
    return this.activeRuns.size > 0;
  }

  public prepareRunRequest(request: AgentRunRequest): Promise<AgentRunRequest> {
    if (!this.acceptingRuns) {
      return Promise.reject(new Error("Agent service is not accepting runs"));
    }

    if (this.dependencies.modelCatalog) {
      const model = this.dependencies.modelCatalog.resolve(request.modelId);
      if (!model) return Promise.reject(new Error("Selected model is not available"));
      return Promise.resolve({
        ...request,
        model,
        effectiveCapabilities: model.effectiveCapabilities,
      });
    }
    return Promise.resolve(request);
  }

  protected override async onDispose(): Promise<void> {
    this.acceptingRuns = false;

    for (const run of this.activeRuns) {
      run.controller.abort();
    }

    const completions = [...this.activeRuns].map((run) =>
      Promise.resolve(run.completion).catch(() => undefined),
    );
    await Promise.all(completions);
    this.activeRuns.clear();
    await this.disposables.dispose();
  }
}
