import { DisposableStore, ManagedService } from "../extension/service-lifecycle";
import type { ProviderService } from "../providers/provider-service";
import type { StorageService } from "../storage/storage-service";

export interface AgentService extends ManagedService {
  readonly serviceName: "agent";
}

export interface AgentServiceDependencies {
  readonly provider: ProviderService;
  readonly storage: StorageService;
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
