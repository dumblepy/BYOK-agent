import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ThreadModelState {
  readonly threadId: string;
  readonly modelId?: string;
  readonly revision: number;
}

export interface ThreadModelStore {
  getThreadModelState(threadId: string): Promise<ThreadModelState>;
  updateThreadModel(
    threadId: string,
    expectedRevision: number,
    modelId: string,
  ): Promise<ThreadModelState>;
}

export class ThreadModelRevisionConflictError extends Error {
  public constructor(
    public readonly threadId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super("The thread model revision is stale");
    this.name = "ThreadModelRevisionConflictError";
  }
}

interface PersistedThreadMetadata {
  readonly title?: unknown;
  readonly workspaceId?: unknown;
  readonly permissionProfile?: unknown;
  readonly createdAt?: unknown;
  readonly archived?: unknown;
  readonly modelId?: unknown;
  readonly revision?: unknown;
  readonly [key: string]: unknown;
}

export interface ThreadModelStoreFileSystem {
  readonly rootPath?: string;
}

/** JSON meta.json backed storage for the thread's selected model. */
export class FileThreadModelStore implements ThreadModelStore {
  private readonly memory = new Map<string, ThreadModelState>();
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(private readonly fileSystem: ThreadModelStoreFileSystem = {}) {}

  public async getThreadModelState(threadId: string): Promise<ThreadModelState> {
    const cached = this.memory.get(threadId);
    if (cached) {
      return cached;
    }

    const filePath = this.getMetaPath(threadId);
    if (!filePath) {
      return this.getMemoryState(threadId);
    }

    try {
      const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      const state = parsePersistedState(value, threadId);
      this.memory.set(threadId, state);
      return state;
    } catch (error) {
      if (isFileNotFound(error)) {
        return this.getMemoryState(threadId);
      }
      throw error;
    }
  }

  public updateThreadModel(
    threadId: string,
    expectedRevision: number,
    modelId: string,
  ): Promise<ThreadModelState> {
    return this.withThreadLock(threadId, async () => {
      const current = await this.getThreadModelState(threadId);
      if (current.revision !== expectedRevision) {
        throw new ThreadModelRevisionConflictError(threadId, expectedRevision, current.revision);
      }

      const next: ThreadModelState = {
        threadId,
        modelId,
        revision: current.revision + 1,
      };
      await this.persist(threadId, next);
      this.memory.set(threadId, next);
      return next;
    });
  }

  private async persist(threadId: string, state: ThreadModelState): Promise<void> {
    const metaPath = this.getMetaPath(threadId);
    if (!metaPath || !this.fileSystem.rootPath) {
      return;
    }

    const directory = join(this.fileSystem.rootPath, "threads", threadId);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${metaPath}.${randomUUID()}.tmp`;
    const existing = await readPersistedMetadata(metaPath);
    const now = Date.now();
    const metadata = {
      id: threadId,
      title: typeof existing?.title === "string" ? existing.title : "新しいスレッド",
      ...(typeof existing?.workspaceId === "string" ? { workspaceId: existing.workspaceId } : {}),
      modelId: state.modelId,
      revision: state.revision,
      permissionProfile:
        typeof existing?.permissionProfile === "string"
          ? existing.permissionProfile
          : "confirm-writes",
      createdAt: isNonNegativeInteger(existing?.createdAt) ? existing.createdAt : now,
      updatedAt: now,
      archived: typeof existing?.archived === "boolean" ? existing.archived : false,
    };

    try {
      await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, metaPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private getMemoryState(threadId: string): ThreadModelState {
    const state = { threadId, revision: 0 } satisfies ThreadModelState;
    this.memory.set(threadId, state);
    return state;
  }

  private getMetaPath(threadId: string): string | undefined {
    return this.fileSystem.rootPath
      ? join(this.fileSystem.rootPath, "threads", threadId, "meta.json")
      : undefined;
  }

  private async withThreadLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(threadId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(threadId) === queued) {
        this.locks.delete(threadId);
      }
    }
  }
}

function parsePersistedState(value: unknown, threadId: string): ThreadModelState {
  if (!isRecord(value)) {
    return { threadId, revision: 0 };
  }

  return {
    threadId,
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    revision: isNonNegativeInteger(value.revision) ? value.revision : 0,
  };
}

function isRecord(value: unknown): value is PersistedThreadMetadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function readPersistedMetadata(
  metaPath: string,
): Promise<PersistedThreadMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(metaPath, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}
