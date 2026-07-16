import type { SecretStorage } from "vscode";

import { DisposableStore, ManagedService } from "../extension/service-lifecycle";
import { ExtensionSecretStore, type SecretStore } from "./secret-store";

export interface ProviderService extends ManagedService {
  readonly serviceName: "provider";
  getApiKey(providerId: string): Promise<string | undefined>;
  getApiKeyStatus(providerId: string): Promise<"configured" | "not-configured" | "unavailable">;
  setApiKey(providerId: string, value: string): Promise<void>;
  deleteApiKey(providerId: string): Promise<void>;
  getCredentialRevision?(providerId: string): number;
}

export interface ProviderServiceDependencies {
  readonly secretStorage: SecretStorage;
  readonly secretStore?: SecretStore;
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
  private readonly credentialRevisions = new Map<string, number>();

  private readonly secretStore: SecretStore;

  public constructor(private readonly dependencies: ProviderServiceDependencies) {
    super();
    this.secretStore =
      dependencies.secretStore ?? new ExtensionSecretStore(dependencies.secretStorage);
  }

  protected override onInitialize(): void {
    // Keep SecretStorage inside the Extension Host. Adapter setup is added later.
    void this.dependencies.secretStorage;
  }

  public getApiKey(providerId: string): Promise<string | undefined> {
    return this.secretStore.get(providerId);
  }

  public async getApiKeyStatus(
    providerId: string,
  ): Promise<"configured" | "not-configured" | "unavailable"> {
    try {
      const value = await this.secretStore.get(providerId);
      return value === undefined || value.length === 0 ? "not-configured" : "configured";
    } catch {
      return "unavailable";
    }
  }

  public setApiKey(providerId: string, value: string): Promise<void> {
    return this.secretStore.set(providerId, value).then(() => {
      this.bumpCredentialRevision(providerId);
    });
  }

  public deleteApiKey(providerId: string): Promise<void> {
    return this.secretStore.delete(providerId).then(() => {
      this.bumpCredentialRevision(providerId);
    });
  }

  public getCredentialRevision(providerId: string): number {
    return this.credentialRevisions.get(providerId) ?? 0;
  }

  private bumpCredentialRevision(providerId: string): void {
    this.credentialRevisions.set(providerId, this.getCredentialRevision(providerId) + 1);
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
