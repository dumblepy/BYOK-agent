import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ARTIFACT_OPTIONS = {
  maxTotalBytes: 256 * 1024 * 1024,
  maxThreadBytes: 64 * 1024 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  retentionDays: 30,
  evictionPolicy: "oldest-first",
} as const;

export type ArtifactKind = "tool-result" | "command-output" | "diagnostic";
export type ArtifactEncoding = "utf-8" | "binary";
export type ArtifactEvictionPolicy = "oldest-first";

export interface ArtifactStoreOptions {
  readonly rootPath?: string;
  readonly maxTotalBytes?: number;
  readonly maxThreadBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly chunkBytes?: number;
  readonly retentionDays?: number;
  readonly evictionPolicy?: ArtifactEvictionPolicy;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly onDiagnostic?: (diagnostic: ArtifactDiagnostic) => void;
}

export interface CreateArtifactInput {
  readonly threadId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly content: Uint8Array;
  readonly createdAt?: number;
  readonly leaseId?: string;
}

export interface ArtifactMetadata {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly artifactId: string;
  readonly threadId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly contentHash: string;
  readonly createdAt: number;
}

export interface ArtifactRef {
  readonly uri: `artifact://${string}/${string}`;
  readonly artifactId: string;
  readonly threadId: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly contentHash: string;
}

export interface ArtifactReadOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly expectedHash?: string;
  readonly leaseId?: string;
}

export interface ArtifactReadResult {
  readonly metadata: ArtifactMetadata;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly complete: boolean;
}

export interface ArtifactSweepReport {
  readonly scanned: number;
  readonly deleted: number;
  readonly invalidated: number;
  readonly bytesFreed: number;
  readonly diagnostics: readonly ArtifactDiagnosticCode[];
}

export type ArtifactDiagnosticCode = "expired" | "evicted" | "orphaned" | "corrupt" | "unreadable";

export interface ArtifactDiagnostic {
  readonly code: ArtifactDiagnosticCode;
  readonly threadId?: string;
  readonly artifactId?: string;
  readonly byteLength?: number;
}

export type ArtifactErrorCode =
  | "ARTIFACT_INVALID_INPUT"
  | "ARTIFACT_SENSITIVE_CONTENT"
  | "ARTIFACT_QUOTA_EXCEEDED"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CORRUPTED"
  | "ARTIFACT_IO_FAILED";

export class ArtifactStoreError extends Error {
  public constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

export interface ArtifactLease {
  readonly leaseId: string;
  readonly uri: string;
  release(): void;
}

export interface ArtifactStore {
  create(input: CreateArtifactInput, signal?: AbortSignal): Promise<ArtifactRef>;
  read(ref: string, options?: ArtifactReadOptions): Promise<ArtifactReadResult>;
  stat(ref: string): Promise<ArtifactMetadata | undefined>;
  delete(ref: string, reason: "eviction" | "thread-cleanup"): Promise<void>;
  sweep(): Promise<ArtifactSweepReport>;
  acquireLease(ref: string): Promise<ArtifactLease>;
}

interface MemoryArtifact {
  readonly metadata: ArtifactMetadata;
  readonly content: Uint8Array;
}

interface ListedArtifact {
  readonly metadata: ArtifactMetadata;
  readonly path?: string;
}

const MAX_THREAD_ID_LENGTH = 128;
const MAX_MEDIA_TYPE_LENGTH = 128;
const MAX_READ_BYTES = 256 * 1024;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URI_PATTERN = /^artifact:\/\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/([0-9a-f-]{36})$/i;

export class FileArtifactStore implements ArtifactStore {
  private readonly options: Required<
    Pick<
      ArtifactStoreOptions,
      | "maxTotalBytes"
      | "maxThreadBytes"
      | "maxArtifactBytes"
      | "chunkBytes"
      | "retentionDays"
      | "evictionPolicy"
    >
  > &
    Pick<ArtifactStoreOptions, "rootPath" | "now" | "idFactory" | "onDiagnostic">;
  private readonly memory = new Map<string, MemoryArtifact>();
  private readonly leases = new Map<string, Set<string>>();
  private lock: Promise<void> = Promise.resolve();

  public constructor(options: ArtifactStoreOptions = {}) {
    const maxTotalBytes = positiveOrDefault(
      options.maxTotalBytes,
      DEFAULT_ARTIFACT_OPTIONS.maxTotalBytes,
    );
    const maxThreadBytes = Math.min(
      positiveOrDefault(options.maxThreadBytes, DEFAULT_ARTIFACT_OPTIONS.maxThreadBytes),
      maxTotalBytes,
    );
    const maxArtifactBytes = Math.min(
      positiveOrDefault(options.maxArtifactBytes, DEFAULT_ARTIFACT_OPTIONS.maxArtifactBytes),
      maxThreadBytes,
    );
    this.options = {
      maxTotalBytes,
      maxThreadBytes,
      maxArtifactBytes,
      chunkBytes: Math.min(
        positiveOrDefault(options.chunkBytes, DEFAULT_ARTIFACT_OPTIONS.chunkBytes),
        maxArtifactBytes,
      ),
      retentionDays: positiveOrDefault(
        options.retentionDays,
        DEFAULT_ARTIFACT_OPTIONS.retentionDays,
      ),
      evictionPolicy:
        options.evictionPolicy === "oldest-first"
          ? options.evictionPolicy
          : DEFAULT_ARTIFACT_OPTIONS.evictionPolicy,
      rootPath: options.rootPath,
      now: options.now,
      idFactory: options.idFactory,
      onDiagnostic: options.onDiagnostic,
    };
    validateOptions(this.options);
  }

  public async create(input: CreateArtifactInput, signal?: AbortSignal): Promise<ArtifactRef> {
    validateCreateInput(input);
    if (input.content.byteLength > this.options.maxArtifactBytes) {
      throw new ArtifactStoreError("ARTIFACT_QUOTA_EXCEEDED", "artifact quota exceeded");
    }
    throwIfAborted(signal);
    return this.withLock(async () => {
      await this.sweepInternal();
      const existing = await this.listArtifacts();
      const candidates = existing.filter((item) => !this.isLeased(toUri(item.metadata)));
      let total = existing.reduce((sum, item) => sum + item.metadata.byteLength, 0);
      let threadTotal = existing
        .filter((item) => item.metadata.threadId === input.threadId)
        .reduce((sum, item) => sum + item.metadata.byteLength, 0);
      for (const candidate of candidates.sort(compareOldest)) {
        if (
          total + input.content.byteLength <= this.options.maxTotalBytes &&
          threadTotal + input.content.byteLength <= this.options.maxThreadBytes
        ) {
          break;
        }
        await this.deleteMetadata(candidate);
        total -= candidate.metadata.byteLength;
        if (candidate.metadata.threadId === input.threadId) {
          threadTotal -= candidate.metadata.byteLength;
        }
        this.emit({
          code: "evicted",
          threadId: candidate.metadata.threadId,
          artifactId: candidate.metadata.artifactId,
          byteLength: candidate.metadata.byteLength,
        });
      }
      if (
        total + input.content.byteLength > this.options.maxTotalBytes ||
        threadTotal + input.content.byteLength > this.options.maxThreadBytes
      ) {
        throw new ArtifactStoreError("ARTIFACT_QUOTA_EXCEEDED", "artifact quota exceeded");
      }

      const artifactId = this.createId();
      const createdAt = input.createdAt ?? this.now();
      validateTimestamp(createdAt);
      const metadata: ArtifactMetadata = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactId,
        threadId: input.threadId,
        kind: input.kind,
        mediaType: input.mediaType,
        encoding: input.encoding,
        byteLength: input.content.byteLength,
        chunkCount: Math.max(1, Math.ceil(input.content.byteLength / this.options.chunkBytes)),
        contentHash: hash(input.content),
        createdAt,
      };
      throwIfAborted(signal);
      await this.publish(metadata, input.content, signal);
      if (input.leaseId) this.addLease(toUri(metadata), input.leaseId);
      return toRef(metadata);
    });
  }

  public async read(ref: string, options: ArtifactReadOptions = {}): Promise<ArtifactReadResult> {
    const metadata = await this.stat(ref);
    if (!metadata) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact not found");
    validateReadOptions(options);
    if (options.leaseId && !this.isLeaseValid(ref, options.leaseId)) {
      throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact lease is not valid");
    }
    const content = await this.readContent(metadata);
    if (content.byteLength !== metadata.byteLength) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPTED", "artifact content size mismatch");
    }
    if (hash(content) !== metadata.contentHash) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPTED", "artifact content hash mismatch");
    }
    if (options.expectedHash && options.expectedHash !== metadata.contentHash) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPTED", "artifact hash does not match");
    }
    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? MAX_READ_BYTES, MAX_READ_BYTES);
    const bytes = content.slice(offset, offset + limit);
    return { metadata, offset, bytes, complete: offset + bytes.byteLength >= content.byteLength };
  }

  public async stat(ref: string): Promise<ArtifactMetadata | undefined> {
    const parsed = parseUri(ref);
    if (!parsed) return undefined;
    if (!this.options.rootPath) return this.memory.get(ref)?.metadata;
    const path = this.getArtifactPath(parsed.threadId, parsed.artifactId);
    try {
      await this.assertInsideArtifacts(path);
      const raw = await readFile(join(path, "meta.json"), "utf8");
      return parseMetadata(JSON.parse(raw), parsed.threadId, parsed.artifactId);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "failed to read artifact metadata", {
        cause: error,
      });
    }
  }

  public async acquireLease(ref: string): Promise<ArtifactLease> {
    const metadata = await this.stat(ref);
    if (!metadata) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact not found");
    const leaseId = this.createId();
    const uri = toUri(metadata);
    this.addLease(uri, leaseId);
    return { leaseId, uri, release: () => this.releaseLease(uri, leaseId) };
  }

  public releaseLease(ref: string, leaseId: string): void {
    const leases = this.leases.get(ref);
    leases?.delete(leaseId);
    if (leases?.size === 0) this.leases.delete(ref);
  }

  public async delete(ref: string, _reason: "eviction" | "thread-cleanup"): Promise<void> {
    const metadata = await this.stat(ref);
    if (!metadata || this.isLeased(ref)) return;
    await this.deleteMetadata({
      metadata,
      path: this.options.rootPath
        ? this.getArtifactPath(metadata.threadId, metadata.artifactId)
        : undefined,
    });
  }

  public sweep(): Promise<ArtifactSweepReport> {
    return this.withLock(() => this.sweepInternal());
  }

  private async sweepInternal(): Promise<ArtifactSweepReport> {
    const artifacts = await this.listArtifacts();
    const now = this.now();
    const expired = artifacts.filter(
      (item) => now - item.metadata.createdAt >= this.options.retentionDays * 24 * 60 * 60 * 1000,
    );
    let deleted = 0;
    let bytesFreed = 0;
    for (const item of expired) {
      if (this.isLeased(toUri(item.metadata))) continue;
      await this.deleteMetadata(item);
      deleted += 1;
      bytesFreed += item.metadata.byteLength;
      this.emit({ code: "expired", ...metadataIdentity(item.metadata) });
    }
    return {
      scanned: artifacts.length,
      deleted,
      invalidated: 0,
      bytesFreed,
      diagnostics: expired.map(() => "expired"),
    };
  }

  private async listArtifacts(): Promise<ListedArtifact[]> {
    if (!this.options.rootPath) {
      return [...this.memory.values()].map((item) => ({ metadata: item.metadata }));
    }
    const artifacts: ListedArtifact[] = [];
    const threadsPath = join(this.options.rootPath, "threads");
    let threads: string[];
    try {
      threads = await readdir(threadsPath);
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "failed to list artifact threads", {
        cause: error,
      });
    }
    for (const threadId of threads) {
      if (!isValidThreadId(threadId)) continue;
      const artifactsPath = join(threadsPath, threadId, "artifacts");
      let entries: string[];
      try {
        entries = await readdir(artifactsPath);
      } catch (error) {
        if (isFileNotFound(error)) continue;
        throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "failed to list artifacts", {
          cause: error,
        });
      }
      for (const artifactId of entries) {
        if (!UUID_PATTERN.test(artifactId)) continue;
        const path = join(artifactsPath, artifactId);
        try {
          const raw = await readFile(join(path, "meta.json"), "utf8");
          artifacts.push({ metadata: parseMetadata(JSON.parse(raw), threadId, artifactId), path });
        } catch (error) {
          if (!isFileNotFound(error)) this.emit({ code: "corrupt", threadId, artifactId });
          await rm(path, { recursive: true, force: true });
        }
      }
    }
    return artifacts;
  }

  private async publish(
    metadata: ArtifactMetadata,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.options.rootPath) {
      this.memory.set(toUri(metadata), { metadata, content: content.slice() });
      return;
    }
    const artifactsPath = join(this.options.rootPath, "threads", metadata.threadId, "artifacts");
    const finalPath = join(artifactsPath, metadata.artifactId);
    const temporaryPath = join(artifactsPath, `.tmp-${metadata.artifactId}-${this.createId()}`);
    try {
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      if (metadata.chunkCount === 1) {
        await writeFile(join(temporaryPath, "content"), content, { mode: 0o600 });
      } else {
        const chunksPath = join(temporaryPath, "chunks");
        await mkdir(chunksPath, { mode: 0o700 });
        for (
          let offset = 0, index = 0;
          offset < content.byteLength;
          offset += this.options.chunkBytes, index += 1
        ) {
          throwIfAborted(signal);
          await writeFile(
            join(chunksPath, index.toString().padStart(6, "0")),
            content.slice(offset, offset + this.options.chunkBytes),
            { mode: 0o600 },
          );
        }
      }
      throwIfAborted(signal);
      await writeFile(join(temporaryPath, "meta.json"), `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await mkdir(artifactsPath, { recursive: true, mode: 0o700 });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "failed to publish artifact", {
        cause: error,
      });
    }
  }

  private async readContent(metadata: ArtifactMetadata): Promise<Uint8Array> {
    if (!this.options.rootPath) {
      const memory = this.memory.get(toUri(metadata));
      if (!memory) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact not found");
      return memory.content.slice();
    }
    const path = this.getArtifactPath(metadata.threadId, metadata.artifactId);
    await this.assertInsideArtifacts(path);
    try {
      if (metadata.chunkCount === 1) return new Uint8Array(await readFile(join(path, "content")));
      const chunks = await Promise.all(
        Array.from({ length: metadata.chunkCount }, (_, index) =>
          readFile(join(path, "chunks", index.toString().padStart(6, "0"))),
        ),
      );
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      if (isFileNotFound(error))
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact content not found");
      throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "failed to read artifact content", {
        cause: error,
      });
    }
  }

  private async deleteMetadata(item: ListedArtifact): Promise<void> {
    const uri = toUri(item.metadata);
    if (!this.options.rootPath) {
      this.memory.delete(uri);
      return;
    }
    await rm(item.path ?? this.getArtifactPath(item.metadata.threadId, item.metadata.artifactId), {
      recursive: true,
      force: true,
    });
  }

  private getArtifactPath(threadId: string, artifactId: string): string {
    return join(this.options.rootPath ?? "", "threads", threadId, "artifacts", artifactId);
  }

  private async assertInsideArtifacts(path: string): Promise<void> {
    const artifactsRoot = resolve(join(this.options.rootPath ?? "", "threads"));
    const resolvedRoot = await realpath(artifactsRoot).catch(() => artifactsRoot);
    const resolvedPath = await realpath(path);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) {
      throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "artifact is outside storage root");
    }
  }

  private createId(): string {
    const id = this.options.idFactory?.() ?? randomUUID();
    if (!UUID_PATTERN.test(id))
      throw new ArtifactStoreError("ARTIFACT_INVALID_INPUT", "invalid artifact id");
    return id;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private addLease(uri: string, leaseId: string): void {
    const leases = this.leases.get(uri) ?? new Set<string>();
    leases.add(leaseId);
    this.leases.set(uri, leases);
  }

  private isLeaseValid(uri: string, leaseId: string): boolean {
    return this.leases.get(uri)?.has(leaseId) ?? false;
  }

  private isLeased(uri: string): boolean {
    return (this.leases.get(uri)?.size ?? 0) > 0;
  }

  private emit(diagnostic: ArtifactDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function validateOptions(options: ArtifactStoreOptions): void {
  const maxTotalBytes = options.maxTotalBytes;
  const maxThreadBytes = options.maxThreadBytes;
  const maxArtifactBytes = options.maxArtifactBytes;
  const chunkBytes = options.chunkBytes;
  const retentionDays = options.retentionDays;
  if (
    [maxTotalBytes, maxThreadBytes, maxArtifactBytes, chunkBytes, retentionDays].some(
      (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new ArtifactStoreError(
      "ARTIFACT_INVALID_INPUT",
      "artifact options must be positive integers",
    );
  }
  if (
    maxThreadBytes === undefined ||
    maxTotalBytes === undefined ||
    maxArtifactBytes === undefined ||
    chunkBytes === undefined ||
    maxThreadBytes > maxTotalBytes ||
    maxArtifactBytes > maxThreadBytes ||
    chunkBytes > maxArtifactBytes
  ) {
    throw new ArtifactStoreError("ARTIFACT_INVALID_INPUT", "artifact options have invalid limits");
  }
  if (options.evictionPolicy !== "oldest-first") {
    throw new ArtifactStoreError("ARTIFACT_INVALID_INPUT", "unsupported artifact eviction policy");
  }
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validateCreateInput(input: CreateArtifactInput): void {
  if (!isValidThreadId(input.threadId)) throw invalidInput("threadId");
  if (!isArtifactKind(input.kind) || !isArtifactEncoding(input.encoding))
    throw invalidInput("kind");
  if (!isValidMediaType(input.mediaType)) throw invalidInput("mediaType");
  if (!(input.content instanceof Uint8Array)) throw invalidInput("content");
  if (input.createdAt !== undefined) validateTimestamp(input.createdAt);
}

function validateReadOptions(options: ArtifactReadOptions): void {
  if (
    options.offset !== undefined &&
    (!Number.isSafeInteger(options.offset) || options.offset < 0)
  ) {
    throw invalidInput("offset");
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw invalidInput("limit");
  }
  if (options.expectedHash !== undefined && !/^[0-9a-f]{64}$/i.test(options.expectedHash)) {
    throw invalidInput("expectedHash");
  }
}

function parseUri(
  value: string,
): { readonly threadId: string; readonly artifactId: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = URI_PATTERN.exec(value);
  if (!match || !UUID_PATTERN.test(match[2])) return undefined;
  return { threadId: match[1], artifactId: match[2] };
}

function parseMetadata(value: unknown, threadId: string, artifactId: string): ArtifactMetadata {
  if (!isRecord(value)) {
    throw new ArtifactStoreError("ARTIFACT_CORRUPTED", "invalid artifact metadata");
  }
  const byteLength = value.byteLength;
  const chunkCount = value.chunkCount;
  const createdAt = value.createdAt;
  if (
    value.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
    value.threadId !== threadId ||
    value.artifactId !== artifactId ||
    !isArtifactKind(value.kind) ||
    !isArtifactEncoding(value.encoding) ||
    !isValidMediaType(value.mediaType) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    typeof chunkCount !== "number" ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.contentHash) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new ArtifactStoreError("ARTIFACT_CORRUPTED", "invalid artifact metadata");
  }
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactId,
    threadId,
    kind: value.kind,
    mediaType: value.mediaType,
    encoding: value.encoding,
    byteLength,
    chunkCount,
    contentHash: value.contentHash,
    createdAt,
  };
}

function toUri(
  metadata: Pick<ArtifactMetadata, "threadId" | "artifactId">,
): `artifact://${string}/${string}` {
  return `artifact://${metadata.threadId}/${metadata.artifactId}`;
}

function toRef(metadata: ArtifactMetadata): ArtifactRef {
  return {
    uri: toUri(metadata),
    artifactId: metadata.artifactId,
    threadId: metadata.threadId,
    byteLength: metadata.byteLength,
    mediaType: metadata.mediaType,
    contentHash: metadata.contentHash,
  };
}

function compareOldest(a: ListedArtifact, b: ListedArtifact): number {
  return (
    a.metadata.createdAt - b.metadata.createdAt ||
    a.metadata.artifactId.localeCompare(b.metadata.artifactId)
  );
}

function metadataIdentity(
  metadata: ArtifactMetadata,
): Pick<ArtifactDiagnostic, "threadId" | "artifactId" | "byteLength"> {
  return {
    threadId: metadata.threadId,
    artifactId: metadata.artifactId,
    byteLength: metadata.byteLength,
  };
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput("createdAt");
}

function invalidInput(name: string): ArtifactStoreError {
  return new ArtifactStoreError("ARTIFACT_INVALID_INPUT", `invalid artifact ${name}`);
}

function isValidThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_THREAD_ID_LENGTH &&
    THREAD_ID_PATTERN.test(value)
  );
}

function isValidMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MEDIA_TYPE_LENGTH &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === "tool-result" || value === "command-output" || value === "diagnostic";
}

function isArtifactEncoding(value: unknown): value is ArtifactEncoding {
  return value === "utf-8" || value === "binary";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ArtifactStoreError("ARTIFACT_IO_FAILED", "artifact operation cancelled");
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
