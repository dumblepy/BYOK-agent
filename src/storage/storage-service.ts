import { homedir } from "node:os";
import { join } from "node:path";

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
import { ThreadTitleService, type ThreadTitleServiceOptions } from "./thread-title";
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
  appendUserMessage(threadId: string, event: NewPersistedAgentEvent): Promise<PersistedAgentEvent>;
}

export interface StorageServiceDependencies {
  /** Kept for activation compatibility; conversation data uses the user-global root below. */
  readonly globalStorageUri: Uri;
  /** Test/integration override. Production callers should omit this. */
  readonly rootPath?: string;
  readonly artifactOptions?: Omit<ArtifactStoreOptions, "rootPath">;
  readonly threadTitleOptions?: ThreadTitleServiceOptions;
}

export const DEFAULT_STORAGE_DIRECTORY = ".byok-agent";

/** Lifecycle boundary for JSONL conversation and file-based artifact storage. */
export class DefaultStorageService extends ManagedService implements StorageService {
  public readonly serviceName = "storage" as const;

  private readonly disposables = new DisposableStore();
  private readonly threadModelStore: ThreadModelStore;
  private readonly threadStore: ThreadStore;
  private readonly eventStore: EventStore;
  private readonly threadTitleService: ThreadTitleService;
  public readonly artifacts: FileArtifactStore;

  public constructor(dependencies: StorageServiceDependencies) {
    super();
    const rootPath = dependencies.rootPath ?? getDefaultStorageRootPath();
    const fileSystem: ThreadModelStoreFileSystem = { rootPath };
    const modelStore = new FileThreadModelStore(fileSystem);
    this.threadModelStore = modelStore;
    this.threadStore = modelStore.threadStore;
    this.eventStore = new FileEventStore({ rootPath });
    this.threadTitleService = new ThreadTitleService(this.threadStore, {
      ...dependencies.threadTitleOptions,
    });
    this.artifacts = new FileArtifactStore({
      ...dependencies.artifactOptions,
      rootPath,
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

  public rename(threadId: string, expectedRevision: number, title: string): Promise<ThreadRecord> {
    return this.threadStore.rename(threadId, expectedRevision, title);
  }

  public applyGeneratedTitle(
    threadId: string,
    expectedRevision: number,
    title: string,
    source: "provisional" | "llm",
  ): Promise<ThreadRecord> {
    return this.threadStore.applyGeneratedTitle(threadId, expectedRevision, title, source);
  }

  public append(threadId: string, event: NewPersistedAgentEvent): Promise<PersistedAgentEvent> {
    return this.eventStore.append(threadId, event);
  }

  public async appendUserMessage(
    threadId: string,
    event: NewPersistedAgentEvent,
  ): Promise<PersistedAgentEvent> {
    const persisted = await this.eventStore.append(threadId, event);
    if (event.kind !== "user-message" || !isTextPayload(event.payload)) return persisted;

    const events = await this.eventStore.read(threadId);
    const firstUserMessage = events.events.find((candidate) => candidate.kind === "user-message");
    if (firstUserMessage?.eventId === persisted.eventId) {
      try {
        await this.threadTitleService.handleFirstUserMessage(threadId, event.payload.text);
      } catch {
        // The event is the source of truth. A title failure must not reject a saved message.
      }
    }
    return persisted;
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

function isTextPayload(value: unknown): value is { readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly text?: unknown }).text === "string"
  );
}

export function getDefaultStorageRootPath(): string {
  return join(homedir(), DEFAULT_STORAGE_DIRECTORY);
}
