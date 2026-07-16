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
import {
  FileArtifactStore,
  type ArtifactLease,
  type ArtifactReadOptions,
  type ArtifactReadResult,
  type ArtifactRef,
  type ArtifactStoreOptions,
  type ArtifactSweepReport,
  type ArtifactMetadata,
} from "./artifact-store";

export interface StorageService extends ManagedService, ThreadModelStore, ThreadStore, EventStore {
  readonly serviceName: "storage";
  readonly artifacts: FileArtifactStore;
  createArtifact(
    input: Parameters<FileArtifactStore["create"]>[0],
    signal?: AbortSignal,
  ): Promise<ArtifactRef>;
  readArtifact(ref: string, options?: ArtifactReadOptions): Promise<ArtifactReadResult>;
  statArtifact(ref: string): Promise<ArtifactMetadata | undefined>;
  deleteArtifact(ref: string, reason: "eviction" | "thread-cleanup"): Promise<void>;
  sweepArtifacts(): Promise<ArtifactSweepReport>;
  acquireArtifactLease(ref: string): Promise<ArtifactLease>;
}

export interface StorageServiceDependencies {
  readonly globalStorageUri: Uri;
  readonly artifactOptions?: Omit<ArtifactStoreOptions, "rootPath">;
}

/** Lifecycle boundary for JSONL conversation and file-based artifact storage. */
export class DefaultStorageService extends ManagedService implements StorageService {
  public readonly serviceName = "storage" as const;

  private readonly disposables = new DisposableStore();
  private readonly threadModelStore: ThreadModelStore;
  private readonly threadStore: ThreadStore;
  private readonly eventStore: EventStore;
  public readonly artifacts: FileArtifactStore;

  public constructor(private readonly dependencies: StorageServiceDependencies) {
    super();
    const modelStore = new FileThreadModelStore(
      getThreadModelStoreFileSystem(dependencies.globalStorageUri),
    );
    this.threadModelStore = modelStore;
    this.threadStore = modelStore.threadStore;
    this.eventStore = new FileEventStore(getEventStoreFileSystem(dependencies.globalStorageUri));
    this.artifacts = new FileArtifactStore({
      ...dependencies.artifactOptions,
      rootPath: getRootPath(dependencies.globalStorageUri),
    });
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

  public createArtifact(
    input: Parameters<FileArtifactStore["create"]>[0],
    signal?: AbortSignal,
  ): Promise<ArtifactRef> {
    return this.artifacts.create(input, signal);
  }

  public readArtifact(ref: string, options?: ArtifactReadOptions): Promise<ArtifactReadResult> {
    return this.artifacts.read(ref, options);
  }

  public statArtifact(ref: string): Promise<ArtifactMetadata | undefined> {
    return this.artifacts.stat(ref);
  }

  public deleteArtifact(ref: string, reason: "eviction" | "thread-cleanup"): Promise<void> {
    return this.artifacts.delete(ref, reason);
  }

  public sweepArtifacts(): Promise<ArtifactSweepReport> {
    return this.artifacts.sweep();
  }

  public acquireArtifactLease(ref: string): Promise<ArtifactLease> {
    return this.artifacts.acquireLease(ref);
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
    await this.artifacts.sweep();
  }

  protected override onDispose(): Promise<void> {
    return this.disposables.dispose();
  }
}

function getThreadModelStoreFileSystem(globalStorageUri: Uri): ThreadModelStoreFileSystem {
  const rootPath = getRootPath(globalStorageUri);
  return rootPath ? { rootPath } : {};
}

function getEventStoreFileSystem(globalStorageUri: Uri): { readonly rootPath?: string } {
  const rootPath = getRootPath(globalStorageUri);
  return rootPath ? { rootPath } : {};
}

function getRootPath(globalStorageUri: Uri): string | undefined {
  const rootPath = (globalStorageUri as Uri & { readonly fsPath?: unknown }).fsPath;
  return typeof rootPath === "string" ? rootPath : undefined;
}
