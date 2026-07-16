import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isUserSelectablePermissionProfile,
  type UserSelectablePermissionProfile,
} from "../permissions/permission-profile";
import { DEFAULT_THREAD_TITLE, type ThreadTitleSource } from "./thread-title";

export interface ThreadRecord {
  readonly id: string;
  readonly title: string;
  readonly titleSource: ThreadTitleSource;
  readonly workspaceId?: string;
  readonly modelId?: string;
  readonly permissionProfile: UserSelectablePermissionProfile;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

export interface CreateThreadInput {
  readonly title?: string;
  readonly workspaceId?: string;
  readonly modelId?: string;
  readonly permissionProfile?: UserSelectablePermissionProfile;
}

export interface ThreadUpdate {
  readonly title?: string;
  readonly modelId?: string;
  readonly permissionProfile?: UserSelectablePermissionProfile;
}

export interface ThreadStore {
  create(input?: CreateThreadInput): Promise<ThreadRecord>;
  get(threadId: string): Promise<ThreadRecord | undefined>;
  list(options?: { readonly includeArchived?: boolean }): Promise<readonly ThreadRecord[]>;
  update(threadId: string, expectedRevision: number, patch: ThreadUpdate): Promise<ThreadRecord>;
  rename(threadId: string, expectedRevision: number, title: string): Promise<ThreadRecord>;
  applyGeneratedTitle(
    threadId: string,
    expectedRevision: number,
    title: string,
    source: "provisional" | "llm",
  ): Promise<ThreadRecord>;
  archive(threadId: string, expectedRevision: number): Promise<ThreadRecord>;
}

export interface ThreadStoreFileSystem {
  readonly rootPath?: string;
  readonly onIgnoredEntry?: (entryPath: string, reason: "invalid" | "unreadable") => void;
}

export class ThreadRevisionConflictError extends Error {
  public constructor(
    public readonly threadId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super("The thread revision is stale");
    this.name = "ThreadRevisionConflictError";
  }
}

export class ThreadNotFoundError extends Error {
  public constructor(public readonly threadId: string) {
    super("The thread was not found");
    this.name = "ThreadNotFoundError";
  }
}

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_IDENTIFIER_LENGTH = 512;
const DEFAULT_TITLE = DEFAULT_THREAD_TITLE;

export class FileThreadStore implements ThreadStore {
  private readonly memory = new Map<string, ThreadRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private initialized = false;

  public constructor(private readonly fileSystem: ThreadStoreFileSystem = {}) {}

  public async create(input: CreateThreadInput = {}): Promise<ThreadRecord> {
    const title = validateTitle(input.title ?? DEFAULT_TITLE);
    const workspaceId = validateOptionalIdentifier(input.workspaceId, "workspaceId");
    const modelId = validateOptionalIdentifier(input.modelId, "modelId");
    const permissionProfile = validatePermission(input.permissionProfile ?? "confirm-writes");
    await this.ensureInitialized();

    for (;;) {
      const id = randomUUID();
      const now = Date.now();
      const record: ThreadRecord = {
        id,
        title,
        titleSource: input.title === undefined ? "default" : "user",
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(modelId === undefined ? {} : { modelId }),
        permissionProfile,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        archived: false,
      };
      try {
        await this.writeRecord(record, true);
        this.memory.set(id, record);
        return record;
      } catch (error) {
        if (!isFileExists(error)) throw error;
      }
    }
  }

  public async get(threadId: string): Promise<ThreadRecord | undefined> {
    validateThreadId(threadId);
    await this.ensureInitialized();
    if (this.memory.has(threadId)) return this.memory.get(threadId);
    const record = await this.readRecord(threadId, true);
    if (record) this.memory.set(threadId, record);
    return record;
  }

  public async list(
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly ThreadRecord[]> {
    await this.ensureInitialized();
    return [...this.memory.values()]
      .filter((record) => options.includeArchived === true || !record.archived)
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      );
  }

  public update(
    threadId: string,
    expectedRevision: number,
    patch: ThreadUpdate,
  ): Promise<ThreadRecord> {
    validateThreadId(threadId);
    validateRevision(expectedRevision);
    const title = patch.title === undefined ? undefined : validateTitle(patch.title);
    const modelId =
      patch.modelId === undefined
        ? undefined
        : validateOptionalIdentifier(patch.modelId, "modelId");
    const permissionProfile =
      patch.permissionProfile === undefined
        ? undefined
        : validatePermission(patch.permissionProfile);
    return this.withThreadLock(threadId, async () => {
      const current = await this.requireCurrent(threadId, true);
      if (current.revision !== expectedRevision)
        throw new ThreadRevisionConflictError(threadId, expectedRevision, current.revision);
      const next: ThreadRecord = {
        ...current,
        ...(title === undefined ? {} : { title }),
        ...(title === undefined ? {} : { titleSource: "user" as const }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(permissionProfile === undefined ? {} : { permissionProfile }),
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      await this.writeRecord(next, false);
      this.memory.set(threadId, next);
      return next;
    });
  }

  public rename(threadId: string, expectedRevision: number, title: string): Promise<ThreadRecord> {
    return this.update(threadId, expectedRevision, { title });
  }

  public applyGeneratedTitle(
    threadId: string,
    expectedRevision: number,
    title: string,
    source: "provisional" | "llm",
  ): Promise<ThreadRecord> {
    validateThreadId(threadId);
    validateRevision(expectedRevision);
    const validatedTitle = validateTitle(title);
    return this.withThreadLock(threadId, async () => {
      const current = await this.requireCurrent(threadId, true);
      if (current.revision !== expectedRevision) {
        throw new ThreadRevisionConflictError(threadId, expectedRevision, current.revision);
      }
      if (
        (source === "provisional" && current.titleSource !== "default") ||
        (source === "llm" && current.titleSource !== "provisional")
      ) {
        return current;
      }
      const next: ThreadRecord = {
        ...current,
        title: validatedTitle,
        titleSource: source,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      await this.writeRecord(next, false);
      this.memory.set(threadId, next);
      return next;
    });
  }

  public archive(threadId: string, expectedRevision: number): Promise<ThreadRecord> {
    validateThreadId(threadId);
    validateRevision(expectedRevision);
    return this.withThreadLock(threadId, async () => {
      const current = await this.requireCurrent(threadId, true);
      if (current.revision !== expectedRevision)
        throw new ThreadRevisionConflictError(threadId, expectedRevision, current.revision);
      const next = {
        ...current,
        archived: true,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      await this.writeRecord(next, false);
      this.memory.set(threadId, next);
      return next;
    });
  }

  /** Compatibility hook for the legacy model/permission facade. */
  public ensure(threadId: string): Promise<ThreadRecord> {
    validateThreadId(threadId);
    return this.withThreadLock(threadId, async () => {
      const existing = await this.get(threadId);
      if (existing) return existing;
      const now = Date.now();
      const record = {
        id: threadId,
        title: DEFAULT_TITLE,
        titleSource: "default" as const,
        permissionProfile: "confirm-writes" as const,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        archived: false,
      };
      await this.writeRecord(record, true);
      this.memory.set(threadId, record);
      return record;
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.fileSystem.rootPath) return;
    const threadsPath = join(this.fileSystem.rootPath, "threads");
    await mkdir(threadsPath, { recursive: true });
    let entries;
    try {
      entries = await readdir(threadsPath, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const entryPath = join(threadsPath, entry.name);
          try {
            validateThreadId(entry.name);
            const record = await this.readRecord(entry.name, true);
            if (record) this.memory.set(entry.name, record);
          } catch (error) {
            this.fileSystem.onIgnoredEntry?.(
              entryPath,
              error instanceof SyntaxError ? "invalid" : "unreadable",
            );
          }
        }),
    );
  }

  private async requireCurrent(threadId: string, refresh: boolean): Promise<ThreadRecord> {
    const record =
      refresh && this.fileSystem.rootPath
        ? await this.readRecord(threadId, true)
        : await this.get(threadId);
    if (record) this.memory.set(threadId, record);
    if (!record) throw new ThreadNotFoundError(threadId);
    return record;
  }

  private async readRecord(
    threadId: string,
    ignoreErrors: boolean,
  ): Promise<ThreadRecord | undefined> {
    const path = this.getMetaPath(threadId);
    if (!path) return undefined;
    try {
      return parseRecord(JSON.parse(await readFile(path, "utf8")), threadId);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      if (ignoreErrors) {
        this.fileSystem.onIgnoredEntry?.(path, "invalid");
        return undefined;
      }
      throw error;
    }
  }

  private async writeRecord(record: ThreadRecord, exclusive: boolean): Promise<void> {
    if (!this.fileSystem.rootPath) return;
    const directory = join(this.fileSystem.rootPath, "threads", record.id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "meta.json");
    if (exclusive) {
      try {
        await stat(path);
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
    }
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
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
      if (this.locks.get(threadId) === queued) this.locks.delete(threadId);
    }
  }
}

function parseRecord(value: unknown, directoryId: string): ThreadRecord {
  if (!isRecord(value) || value.id !== directoryId)
    throw new SyntaxError("Invalid thread metadata");
  return {
    id: validateThreadId(String(value.id)),
    title: validateTitle(value.title),
    titleSource: validateTitleSource(value.titleSource, value.title),
    ...(validateOptionalIdentifier(value.workspaceId, "workspaceId") === undefined
      ? {}
      : { workspaceId: value.workspaceId as string }),
    ...(validateOptionalIdentifier(value.modelId, "modelId") === undefined
      ? {}
      : { modelId: value.modelId as string }),
    permissionProfile: validatePermission(value.permissionProfile),
    revision: validatePersistedRevision(value.revision),
    createdAt: validateTimestamp(value.createdAt),
    updatedAt: validateTimestamp(value.updatedAt),
    archived:
      typeof value.archived === "boolean"
        ? value.archived
        : (() => {
            throw new SyntaxError("Invalid archived flag");
          })(),
  };
}

function validateThreadId(value: string): string {
  if (
    !value ||
    value.length > MAX_ID_LENGTH ||
    value === "." ||
    value === ".." ||
    /[\\/]/u.test(value) ||
    hasControlCharacters(value)
  )
    throw new TypeError("Invalid thread id");
  return value;
}
function validateTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > MAX_TITLE_LENGTH ||
    hasControlCharacters(value)
  )
    throw new TypeError("Invalid thread title");
  return value;
}
function validateTitleSource(value: unknown, title: unknown): ThreadTitleSource {
  if (value === undefined) return title === DEFAULT_TITLE ? "default" : "user";
  if (value === "default" || value === "provisional" || value === "llm" || value === "user") {
    return value;
  }
  throw new SyntaxError("Invalid thread title source");
}
function validateOptionalIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    hasControlCharacters(value)
  )
    throw new TypeError(`Invalid ${name}`);
  return value;
}
function validatePermission(value: unknown): UserSelectablePermissionProfile {
  if (!isUserSelectablePermissionProfile(value)) throw new TypeError("Invalid permission profile");
  return value;
}
function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid revision");
}
function validatePersistedRevision(value: unknown): number {
  if (typeof value !== "number") throw new SyntaxError("Invalid revision");
  validateRevision(value);
  return value;
}
function validateTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new SyntaxError("Invalid timestamp");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}
function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
function isFileExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
