import type { Uri } from "vscode";

import { DisposableStore, ManagedService } from "../extension/service-lifecycle";

export interface StorageService extends ManagedService {
  readonly serviceName: "storage";
}

export interface StorageServiceDependencies {
  readonly globalStorageUri: Uri;
}

/** Lifecycle boundary for the JSONL-based storage layer. Persistence is implemented later. */
export class DefaultStorageService extends ManagedService implements StorageService {
  public readonly serviceName = "storage" as const;

  private readonly disposables = new DisposableStore();

  public constructor(private readonly dependencies: StorageServiceDependencies) {
    super();
  }

  protected override onInitialize(): void {
    // The URI is retained as a narrow dependency; directory preparation belongs to storage work.
    void this.dependencies.globalStorageUri;
  }

  protected override onDispose(): Promise<void> {
    return this.disposables.dispose();
  }
}
