import type { Uri } from "vscode";

import { DisposableStore, ManagedService } from "../extension/service-lifecycle";
import {
  FileThreadModelStore,
  type ThreadPermissionState,
  type ThreadModelState,
  type ThreadModelStore,
  type ThreadModelStoreFileSystem,
} from "./thread-model-store";
import type { UserSelectablePermissionProfile } from "../permissions/permission-profile";

export interface StorageService extends ManagedService, ThreadModelStore {
  readonly serviceName: "storage";
}

export interface StorageServiceDependencies {
  readonly globalStorageUri: Uri;
}

/** Lifecycle boundary for the JSONL-based storage layer. Persistence is implemented later. */
export class DefaultStorageService extends ManagedService implements StorageService {
  public readonly serviceName = "storage" as const;

  private readonly disposables = new DisposableStore();
  private readonly threadModelStore: ThreadModelStore;

  public constructor(private readonly dependencies: StorageServiceDependencies) {
    super();
    this.threadModelStore = new FileThreadModelStore(
      getThreadModelStoreFileSystem(dependencies.globalStorageUri),
    );
  }

  public getThreadModelState(threadId: string): Promise<ThreadModelState> {
    return this.threadModelStore.getThreadModelState(threadId);
  }

  public updateThreadModel(
    threadId: string,
    expectedRevision: number,
    modelId: string,
  ): Promise<ThreadModelState> {
    return this.threadModelStore.updateThreadModel(threadId, expectedRevision, modelId);
  }

  public getThreadPermissionState(threadId: string): Promise<ThreadPermissionState> {
    return this.threadModelStore.getThreadPermissionState(threadId);
  }

  public updateThreadPermission(
    threadId: string,
    expectedRevision: number,
    permissionProfile: UserSelectablePermissionProfile,
  ): Promise<ThreadPermissionState> {
    return this.threadModelStore.updateThreadPermission(
      threadId,
      expectedRevision,
      permissionProfile,
    );
  }

  protected override onInitialize(): void {
    // The URI is retained as a narrow dependency; directory preparation belongs to storage work.
    void this.dependencies.globalStorageUri;
  }

  protected override onDispose(): Promise<void> {
    return this.disposables.dispose();
  }
}

function getThreadModelStoreFileSystem(globalStorageUri: Uri): ThreadModelStoreFileSystem {
  const rootPath = (globalStorageUri as Uri & { readonly fsPath?: unknown }).fsPath;
  return typeof rootPath === "string" ? { rootPath } : {};
}
