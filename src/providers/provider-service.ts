import type { SecretStorage } from "vscode";

import { DisposableStore, ManagedService } from "../extension/service-lifecycle";

export interface ProviderService extends ManagedService {
  readonly serviceName: "provider";
}

export interface ProviderServiceDependencies {
  readonly secretStorage: SecretStorage;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly completion: PromiseLike<void>;
}

/** Lifecycle boundary for provider adapters. Network behavior belongs to later provider work. */
export class DefaultProviderService extends ManagedService implements ProviderService {
  public readonly serviceName = "provider" as const;

  private readonly disposables = new DisposableStore();
  private readonly activeRequests = new Set<ActiveRequest>();

  public constructor(private readonly dependencies: ProviderServiceDependencies) {
    super();
  }

  protected override onInitialize(): void {
    // Keep the SecretStorage dependency inside the Extension Host. Adapter setup is added later.
    void this.dependencies.secretStorage;
  }

  public registerActiveRequest(controller: AbortController, completion: PromiseLike<void>): void {
    const request = { controller, completion };
    this.activeRequests.add(request);
    void Promise.resolve(completion)
      .catch(() => undefined)
      .finally(() => this.activeRequests.delete(request));
  }

  protected override async onDispose(): Promise<void> {
    for (const request of this.activeRequests) {
      request.controller.abort();
    }

    const completions = [...this.activeRequests].map((request) =>
      Promise.resolve(request.completion).catch(() => undefined),
    );
    await Promise.all(completions);
    this.activeRequests.clear();
    await this.disposables.dispose();
  }
}
