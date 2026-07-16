import {
  FileThreadStore,
  ThreadRevisionConflictError,
  type ThreadStoreFileSystem,
} from "./thread-store";
import type { UserSelectablePermissionProfile } from "../permissions/permission-profile";

export type { ThreadStoreFileSystem as ThreadModelStoreFileSystem } from "./thread-store";

export interface ThreadModelState {
  readonly threadId: string;
  readonly modelId?: string;
  readonly revision: number;
}

export interface ThreadPermissionState {
  readonly threadId: string;
  readonly permissionProfile: UserSelectablePermissionProfile;
  readonly revision: number;
}

export interface ThreadModelStore {
  getThreadModelState(threadId: string): Promise<ThreadModelState>;
  updateThreadModel(
    threadId: string,
    expectedRevision: number,
    modelId: string,
  ): Promise<ThreadModelState>;
  getThreadPermissionState(threadId: string): Promise<ThreadPermissionState>;
  updateThreadPermission(
    threadId: string,
    expectedRevision: number,
    permissionProfile: UserSelectablePermissionProfile,
  ): Promise<ThreadPermissionState>;
}

export class ThreadModelRevisionConflictError extends ThreadRevisionConflictError {
  public constructor(threadId: string, expectedRevision: number, actualRevision: number) {
    super(threadId, expectedRevision, actualRevision);
    this.name = "ThreadModelRevisionConflictError";
  }
}

export class ThreadPermissionRevisionConflictError extends ThreadRevisionConflictError {
  public constructor(threadId: string, expectedRevision: number, actualRevision: number) {
    super(threadId, expectedRevision, actualRevision);
    this.name = "ThreadPermissionRevisionConflictError";
  }
}

/** Backward-compatible facade. Thread metadata is persisted by FileThreadStore. */
export class FileThreadModelStore implements ThreadModelStore {
  public readonly threadStore: FileThreadStore;

  public constructor(fileSystem: ThreadStoreFileSystem = {}) {
    this.threadStore = new FileThreadStore(fileSystem);
  }

  public async getThreadModelState(threadId: string): Promise<ThreadModelState> {
    const record = await this.threadStore.ensure(threadId);
    return {
      threadId: record.id,
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      revision: record.revision,
    };
  }

  public async updateThreadModel(
    threadId: string,
    expectedRevision: number,
    modelId: string,
  ): Promise<ThreadModelState> {
    await this.threadStore.ensure(threadId);
    try {
      const record = await this.threadStore.update(threadId, expectedRevision, { modelId });
      return { threadId: record.id, modelId: record.modelId, revision: record.revision };
    } catch (error) {
      if (error instanceof ThreadRevisionConflictError)
        throw new ThreadModelRevisionConflictError(
          threadId,
          expectedRevision,
          error.actualRevision,
        );
      throw error;
    }
  }

  public async getThreadPermissionState(threadId: string): Promise<ThreadPermissionState> {
    const record = await this.threadStore.ensure(threadId);
    return {
      threadId: record.id,
      permissionProfile: record.permissionProfile,
      revision: record.revision,
    };
  }

  public async updateThreadPermission(
    threadId: string,
    expectedRevision: number,
    permissionProfile: UserSelectablePermissionProfile,
  ): Promise<ThreadPermissionState> {
    await this.threadStore.ensure(threadId);
    try {
      const record = await this.threadStore.update(threadId, expectedRevision, {
        permissionProfile,
      });
      return {
        threadId: record.id,
        permissionProfile: record.permissionProfile,
        revision: record.revision,
      };
    } catch (error) {
      if (error instanceof ThreadRevisionConflictError)
        throw new ThreadPermissionRevisionConflictError(
          threadId,
          expectedRevision,
          error.actualRevision,
        );
      throw error;
    }
  }
}

export type { ThreadStoreFileSystem } from "./thread-store";
