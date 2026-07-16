import type { Uri } from "vscode";

import { DisposableStore, ManagedService } from "../extension/service-lifecycle";
import {
  FileThreadModelStore,
  type ThreadPermissionState,
  type ThreadModelState,
  type ThreadModelStore,
  type ThreadModelStoreFileSystem,
} from "./thread-model-store";
import type { CreateThreadInput, ThreadRecord, ThreadStore, ThreadUpdate } from "./thread-store";
import type { UserSelectablePermissionProfile } from "../permissions/permission-profile";
import {
  FileEventStore,
  type EventReadResult,
  type EventSnapshot,
  type EventStore,
  type NewPersistedAgentEvent,
  type PersistedAgentEvent,
} from "./event-store";

export interface StorageService extends ManagedService, ThreadModelStore, ThreadStore, EventStore {
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
  private readonly threadStore: ThreadStore;
  private readonly eventStore: EventStore;

  public constructor(private readonly dependencies: StorageServiceDependencies) {
    super();
    const modelStore = new FileThreadModelStore(
      getThreadModelStoreFileSystem(dependencies.globalStorageUri),
    );
    this.threadModelStore = modelStore;
    this.threadStore = modelStore.threadStore;
    this.eventStore = new FileEventStore(getEventStoreFileSystem(dependencies.globalStorageUri));
  }

  public create(input?: CreateThreadInput): Promise<ThreadRecord> {
    return this.threadStore.create(input);
  }
  public get(threadId: string): Promise<ThreadRecord | undefined> {
    return this.threadStore.get(threadId);
  }
  public list(options?: { readonly includeArchived?: boolean }): Promise<readonly ThreadRecord[]> {
    return this.threadStore.list(options);
  }
  public update(
    threadId: string,
    expectedRevision: number,
    patch: ThreadUpdate,
  ): Promise<ThreadRecord> {
    return this.threadStore.update(threadId, expectedRevision, patch);
  }
  public archive(threadId: string, expectedRevision: number): Promise<ThreadRecord> {
    return this.threadStore.archive(threadId, expectedRevision);
  }

  public append(threadId: string, event: NewPersistedAgentEvent): Promise<PersistedAgentEvent> {
    return this.eventStore.append(threadId, event);
  }

  public appendBatch(
    threadId: string,
    events: readonly NewPersistedAgentEvent[],
  ): Promise<readonly PersistedAgentEvent[]> {
    return this.eventStore.appendBatch(threadId, events);
  }

  public read(
    threadId: string,
    options?: { readonly afterSequence?: number },
  ): Promise<EventReadResult> {
    return this.eventStore.read(threadId, options);
  }

  public getSnapshot(threadId: string): Promise<EventSnapshot | undefined> {
    return this.eventStore.getSnapshot(threadId);
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

  protected override async onInitialize(): Promise<void> {
    await this.threadStore.list();
  }

  protected override onDispose(): Promise<void> {
    return this.disposables.dispose();
  }
}

function getThreadModelStoreFileSystem(globalStorageUri: Uri): ThreadModelStoreFileSystem {
  const rootPath = (globalStorageUri as Uri & { readonly fsPath?: unknown }).fsPath;
  return typeof rootPath === "string" ? { rootPath } : {};
}

function getEventStoreFileSystem(globalStorageUri: Uri): { readonly rootPath?: string } {
  const rootPath = (globalStorageUri as Uri & { readonly fsPath?: unknown }).fsPath;
  return typeof rootPath === "string" ? { rootPath } : {};
}
