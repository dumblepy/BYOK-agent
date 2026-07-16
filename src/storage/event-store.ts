import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PERSISTED_AGENT_EVENT_SCHEMA_VERSION = 1 as const;
export const EVENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EVENT_SNAPSHOT_INTERVAL = 100;

export const PERSISTED_AGENT_EVENT_KINDS = [
  "user-message",
  "assistant-text",
  "tool-call",
  "tool-result",
  "approval",
  "context-snapshot",
  "change-set",
  "usage",
  "error",
] as const;

export type PersistedAgentEventKind = (typeof PERSISTED_AGENT_EVENT_KINDS)[number];

export interface PersistedAgentEvent<TPayload = unknown> {
  readonly schemaVersion: typeof PERSISTED_AGENT_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly kind: PersistedAgentEventKind;
  readonly payload: TPayload;
}

export interface NewPersistedAgentEvent {
  readonly eventId?: string;
  readonly runId: string;
  readonly occurredAt?: number;
  readonly kind: PersistedAgentEventKind;
  readonly payload: unknown;
}

export interface EventRecoveryDiagnostic {
  readonly code:
    | "invalid-json"
    | "invalid-envelope"
    | "unknown-event-kind"
    | "oversized-line"
    | "duplicate-event-id"
    | "duplicate-sequence"
    | "sequence-gap"
    | "out-of-order"
    | "unreadable";
  readonly lineNumber?: number;
}

export interface EventRecoveryReport {
  readonly scannedLines: number;
  readonly acceptedLines: number;
  readonly ignoredLines: number;
  readonly diagnostics: readonly EventRecoveryDiagnostic[];
}

export interface EventReadResult {
  readonly events: readonly PersistedAgentEvent[];
  readonly recovery: EventRecoveryReport;
}

export interface MessageProjection {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly complete: boolean;
}

export interface RunProjection {
  readonly runId: string;
  readonly status: "running" | "completed" | "cancelled" | "failed";
  readonly startedAt: number;
  readonly completedAt?: number;
}

export interface ToolActivityProjection {
  readonly toolCallId: string;
  readonly name: string;
  readonly status:
    "queued" | "approval-required" | "running" | "succeeded" | "failed" | "cancelled";
  readonly summary: string;
}

export interface ErrorProjection {
  readonly code: string;
  readonly message: string;
}

export interface EventProjection {
  readonly messages: readonly MessageProjection[];
  readonly runs: readonly RunProjection[];
  readonly toolActivities: readonly ToolActivityProjection[];
  readonly latestError?: ErrorProjection;
}

export interface EventSnapshot {
  readonly schemaVersion: typeof EVENT_SNAPSHOT_SCHEMA_VERSION;
  readonly threadId: string;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly generatedAt: number;
  readonly state: EventProjection;
}

export interface EventStore {
  append(threadId: string, event: NewPersistedAgentEvent): Promise<PersistedAgentEvent>;
  appendBatch(
    threadId: string,
    events: readonly NewPersistedAgentEvent[],
  ): Promise<readonly PersistedAgentEvent[]>;
  read(threadId: string, options?: { readonly afterSequence?: number }): Promise<EventReadResult>;
  getSnapshot(threadId: string): Promise<EventSnapshot | undefined>;
}

export interface EventStoreFileSystem {
  readonly rootPath?: string;
  readonly snapshotInterval?: number;
  readonly onRecovery?: (threadId: string, report: EventRecoveryReport) => void;
}

export class EventStoreValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EventStoreValidationError";
  }
}

export class EventStorePersistenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventStorePersistenceError";
  }
}

const MAX_THREAD_ID_LENGTH = 128;
const MAX_RUN_ID_LENGTH = 128;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 100_000;
const MAX_PROJECTION_MESSAGES = 1_000;
const MAX_PROJECTION_RUNS = 1_000;
const MAX_PROJECTION_TOOLS = 2_000;
const THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN =
  /^(?:api[-_]?key|authorization|headers?|cookie|secret|password|token|env|environment|prompt|system[-_]?prompt|reasoning|file[-_]?content|raw|body)$/i;
const SENSITIVE_TEXT_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\b(?:api[-_]?key|access[-_]?token|auth(?:orization)?)[ \t]*[:=][ \t]*[^\s,;]+/gi,
];

interface StoredLine {
  readonly event: PersistedAgentEvent;
  readonly lineNumber: number;
}

interface MemorySnapshot {
  readonly events: string;
  readonly snapshot?: string;
}

export class FileEventStore implements EventStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly memory = new Map<string, MemorySnapshot>();
  private readonly snapshotInterval: number;

  public constructor(private readonly fileSystem: EventStoreFileSystem = {}) {
    const interval = fileSystem.snapshotInterval ?? DEFAULT_EVENT_SNAPSHOT_INTERVAL;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new EventStoreValidationError("snapshotInterval must be a positive integer");
    }
    this.snapshotInterval = interval;
  }

  public append(threadId: string, event: NewPersistedAgentEvent): Promise<PersistedAgentEvent> {
    return this.appendBatch(threadId, [event]).then((events) => events[0]);
  }

  public appendBatch(
    threadId: string,
    events: readonly NewPersistedAgentEvent[],
  ): Promise<readonly PersistedAgentEvent[]> {
    validateThreadId(threadId);
    if (events.length === 0) return Promise.resolve([]);
    return this.withThreadLock(threadId, async () => {
      const current = await this.readInternal(threadId);
      const nextSequence = getNextSequence(current.events);
      const persisted = events.map((event, index) =>
        createPersistedEvent(threadId, event, nextSequence + index),
      );
      const serialized = `${persisted.map((event) => JSON.stringify(event)).join("\n")}\n`;
      if (Buffer.byteLength(serialized, "utf8") > events.length * MAX_EVENT_LINE_BYTES) {
        throw new EventStoreValidationError("event batch is too large");
      }

      try {
        await this.appendToFile(threadId, serialized);
      } catch (error) {
        throw new EventStorePersistenceError("failed to append agent events", { cause: error });
      }

      const allEvents = [...current.events, ...persisted];
      if (
        Math.floor(allEvents.length / this.snapshotInterval) >
        Math.floor(current.events.length / this.snapshotInterval)
      ) {
        try {
          await this.writeSnapshot(threadId, allEvents);
        } catch (error) {
          this.fileSystem.onRecovery?.(threadId, {
            scannedLines: allEvents.length,
            acceptedLines: allEvents.length,
            ignoredLines: 0,
            diagnostics: [{ code: "unreadable" }],
          });
          // The append is durable even if the derived cache cannot be refreshed.
          void error;
        }
      }
      return persisted;
    });
  }

  public async read(
    threadId: string,
    options: { readonly afterSequence?: number } = {},
  ): Promise<EventReadResult> {
    validateThreadId(threadId);
    if (
      options.afterSequence !== undefined &&
      (!Number.isInteger(options.afterSequence) || options.afterSequence < 0)
    ) {
      throw new EventStoreValidationError("afterSequence must be a non-negative integer");
    }
    const result = await this.readInternal(threadId);
    const report = result.recovery;
    this.fileSystem.onRecovery?.(threadId, report);
    return {
      events:
        options.afterSequence === undefined
          ? result.events
          : result.events.filter((event) => event.sequence > options.afterSequence!),
      recovery: report,
    };
  }

  public async getSnapshot(threadId: string): Promise<EventSnapshot | undefined> {
    validateThreadId(threadId);
    const raw = await this.readSnapshot(threadId);
    if (!raw) return undefined;
    try {
      return parseSnapshot(JSON.parse(raw), threadId);
    } catch {
      return undefined;
    }
  }

  private async appendToFile(threadId: string, serialized: string): Promise<void> {
    const path = this.getEventsPath(threadId);
    if (!path) {
      const current = this.memory.get(threadId);
      this.memory.set(threadId, {
        events: `${current?.events ?? ""}${serialized}`,
        ...(current?.snapshot === undefined ? {} : { snapshot: current.snapshot }),
      });
      return;
    }
    await mkdir(this.getThreadPath(threadId), { recursive: true });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.write(serialized, null, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeSnapshot(
    threadId: string,
    events: readonly PersistedAgentEvent[],
  ): Promise<void> {
    const snapshot: EventSnapshot = {
      schemaVersion: EVENT_SNAPSHOT_SCHEMA_VERSION,
      threadId,
      lastSequence: events.at(-1)?.sequence ?? 0,
      eventCount: events.length,
      generatedAt: Date.now(),
      state: projectEvents(events),
    };
    const serialized = `${JSON.stringify(snapshot)}\n`;
    const path = this.getSnapshotPath(threadId);
    if (!path) {
      const current = this.memory.get(threadId);
      this.memory.set(threadId, { events: current?.events ?? "", snapshot: serialized });
      return;
    }
    await mkdir(this.getThreadPath(threadId), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async readSnapshot(threadId: string): Promise<string | undefined> {
    const path = this.getSnapshotPath(threadId);
    if (!path) return this.memory.get(threadId)?.snapshot;
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw new EventStorePersistenceError("failed to read event snapshot", { cause: error });
    }
  }

  private async readInternal(threadId: string): Promise<{
    readonly events: readonly PersistedAgentEvent[];
    readonly recovery: EventRecoveryReport;
  }> {
    const raw = await this.readEvents(threadId);
    if (raw === undefined || raw.length === 0) {
      return {
        events: [],
        recovery: { scannedLines: 0, acceptedLines: 0, ignoredLines: 0, diagnostics: [] },
      };
    }
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const diagnostics: EventRecoveryDiagnostic[] = [];
    const accepted: StoredLine[] = [];
    const seenEventIds = new Set<string>();
    const seenSequences = new Set<number>();
    let previousSequence: number | undefined;
    let ignoredLines = 0;

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        diagnostics.push({ code: "oversized-line", lineNumber });
        ignoredLines += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        diagnostics.push({ code: "invalid-json", lineNumber });
        ignoredLines += 1;
        continue;
      }
      const envelope = parseEventEnvelope(parsed, threadId);
      if (envelope.kind === "unknown-event-kind") {
        diagnostics.push({ code: envelope.kind, lineNumber });
        ignoredLines += 1;
        continue;
      }
      if (!envelope.event) {
        diagnostics.push({ code: "invalid-envelope", lineNumber });
        ignoredLines += 1;
        continue;
      }
      if (previousSequence !== undefined && envelope.event.sequence < previousSequence) {
        diagnostics.push({ code: "out-of-order", lineNumber });
      }
      previousSequence = envelope.event.sequence;
      if (seenEventIds.has(envelope.event.eventId)) {
        diagnostics.push({ code: "duplicate-event-id", lineNumber });
        ignoredLines += 1;
        continue;
      }
      if (seenSequences.has(envelope.event.sequence)) {
        diagnostics.push({ code: "duplicate-sequence", lineNumber });
        ignoredLines += 1;
        continue;
      }
      seenEventIds.add(envelope.event.eventId);
      seenSequences.add(envelope.event.sequence);
      accepted.push({ event: envelope.event, lineNumber });
    }

    const sorted = accepted.sort((a, b) => a.event.sequence - b.event.sequence);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].event.sequence > sorted[index - 1].event.sequence + 1) {
        diagnostics.push({ code: "sequence-gap", lineNumber: sorted[index].lineNumber });
      }
    }
    return {
      events: sorted.map(({ event }) => event),
      recovery: {
        scannedLines: lines.length,
        acceptedLines: sorted.length,
        ignoredLines,
        diagnostics,
      },
    };
  }

  private async readEvents(threadId: string): Promise<string | undefined> {
    const path = this.getEventsPath(threadId);
    if (!path) return this.memory.get(threadId)?.events;
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw new EventStorePersistenceError("failed to read agent events", { cause: error });
    }
  }

  private getThreadPath(threadId: string): string {
    return join(this.fileSystem.rootPath ?? "", "threads", threadId);
  }

  private getEventsPath(threadId: string): string | undefined {
    return this.fileSystem.rootPath
      ? join(this.getThreadPath(threadId), "events.jsonl")
      : undefined;
  }

  private getSnapshotPath(threadId: string): string | undefined {
    return this.fileSystem.rootPath
      ? join(this.getThreadPath(threadId), "snapshot.json")
      : undefined;
  }

  private async withThreadLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.locks.set(threadId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(threadId) === current) this.locks.delete(threadId);
    }
  }
}

function createPersistedEvent(
  threadId: string,
  event: NewPersistedAgentEvent,
  sequence: number,
): PersistedAgentEvent {
  if (!isPersistedAgentEventKind(event.kind)) {
    throw new EventStoreValidationError("unknown event kind");
  }
  const eventId = event.eventId ?? randomUUID();
  validateIdentifier(eventId, "eventId", MAX_EVENT_ID_LENGTH, true);
  validateIdentifier(event.runId, "runId", MAX_RUN_ID_LENGTH);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new EventStoreValidationError("sequence must be a positive integer");
  }
  const occurredAt = event.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new EventStoreValidationError("occurredAt must be a non-negative safe integer");
  }
  const payload = sanitizePayload(event.payload);
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new EventStoreValidationError("event payload is too large");
  }
  return {
    schemaVersion: PERSISTED_AGENT_EVENT_SCHEMA_VERSION,
    eventId,
    threadId,
    runId: event.runId,
    sequence,
    occurredAt,
    kind: event.kind,
    payload,
  };
}

function parseEventEnvelope(
  value: unknown,
  threadId: string,
): { readonly event?: PersistedAgentEvent; readonly kind?: "unknown-event-kind" } {
  if (!isRecord(value)) return {};
  if (
    typeof value.schemaVersion !== "number" ||
    value.schemaVersion !== PERSISTED_AGENT_EVENT_SCHEMA_VERSION ||
    typeof value.eventId !== "string" ||
    !UUID_PATTERN.test(value.eventId) ||
    typeof value.threadId !== "string" ||
    value.threadId !== threadId ||
    typeof value.runId !== "string" ||
    !isValidIdentifier(value.runId, MAX_RUN_ID_LENGTH) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    typeof value.occurredAt !== "number" ||
    !Number.isSafeInteger(value.occurredAt) ||
    value.occurredAt < 0 ||
    value.payload === undefined
  ) {
    return {};
  }
  if (!isPersistedAgentEventKind(value.kind)) {
    return { kind: "unknown-event-kind" };
  }
  let payload: unknown;
  try {
    payload = sanitizePayload(value.payload);
  } catch {
    return {};
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) return {};
  return { event: { ...value, kind: value.kind, payload } as PersistedAgentEvent };
}

function parseSnapshot(value: unknown, threadId: string): EventSnapshot {
  if (!isRecord(value)) throw new EventStoreValidationError("invalid snapshot");
  if (
    value.schemaVersion !== EVENT_SNAPSHOT_SCHEMA_VERSION ||
    value.threadId !== threadId ||
    !isNonNegativeSafeInteger(value.lastSequence) ||
    !isNonNegativeSafeInteger(value.eventCount) ||
    !isNonNegativeSafeInteger(value.generatedAt) ||
    !isProjection(value.state)
  ) {
    throw new EventStoreValidationError("invalid snapshot");
  }
  return value as unknown as EventSnapshot;
}

function projectEvents(events: readonly PersistedAgentEvent[]): EventProjection {
  const messages = new Map<string, MessageProjection>();
  const runs = new Map<string, RunProjection>();
  const tools = new Map<string, ToolActivityProjection>();
  let latestError: ErrorProjection | undefined;

  for (const event of events) {
    const run = runs.get(event.runId) ?? {
      runId: event.runId,
      status: "running" as const,
      startedAt: event.occurredAt,
    };
    runs.set(event.runId, run);
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.kind === "user-message" || event.kind === "assistant-text") {
      const messageId =
        typeof payload.messageId === "string"
          ? payload.messageId
          : `${event.runId}-${event.sequence}`;
      const text = typeof payload.text === "string" ? payload.text : "";
      messages.set(messageId, {
        messageId,
        role: event.kind === "user-message" ? "user" : "assistant",
        text: limitText(text),
        complete: payload.complete !== false,
      });
    }
    if (event.kind === "tool-call" || event.kind === "tool-result") {
      const toolCallId =
        typeof payload.toolCallId === "string"
          ? payload.toolCallId
          : `${event.runId}-${event.sequence}`;
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const status = isToolStatus(payload.status)
        ? payload.status
        : event.kind === "tool-call"
          ? "queued"
          : "succeeded";
      tools.set(toolCallId, {
        toolCallId,
        name,
        status,
        summary: limitText(typeof payload.summary === "string" ? payload.summary : ""),
      });
    }
    if (event.kind === "error") {
      latestError = {
        code: typeof payload.code === "string" ? payload.code : "UNKNOWN",
        message: limitText(
          typeof payload.message === "string" ? payload.message : "エージェントエラー",
        ),
      };
      runs.set(event.runId, { ...run, status: "failed", completedAt: event.occurredAt });
    }
    if (event.kind === "usage") {
      runs.set(event.runId, { ...run, status: "completed", completedAt: event.occurredAt });
    }
  }
  return {
    messages: [...messages.values()].slice(-MAX_PROJECTION_MESSAGES),
    runs: [...runs.values()].slice(-MAX_PROJECTION_RUNS),
    toolActivities: [...tools.values()].slice(-MAX_PROJECTION_TOOLS),
    ...(latestError === undefined ? {} : { latestError }),
  };
}

function sanitizePayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(limitText(value));
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  if (!isRecord(value)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    throw new EventStoreValidationError("event payload must be JSON-compatible");
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizePayload(item);
  }
  return result;
}

function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, "[redacted]"),
    value,
  );
}

function isProjection(value: unknown): value is EventProjection {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.toolActivities)
  )
    return false;
  return (
    value.messages.every(
      (item) =>
        isRecord(item) &&
        typeof item.messageId === "string" &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.text === "string" &&
        typeof item.complete === "boolean",
    ) &&
    value.runs.every(
      (item) =>
        isRecord(item) &&
        typeof item.runId === "string" &&
        isRunStatus(item.status) &&
        isNonNegativeSafeInteger(item.startedAt) &&
        (item.completedAt === undefined || isNonNegativeSafeInteger(item.completedAt)),
    ) &&
    value.toolActivities.every(
      (item) =>
        isRecord(item) &&
        typeof item.toolCallId === "string" &&
        typeof item.name === "string" &&
        isToolStatus(item.status) &&
        typeof item.summary === "string",
    ) &&
    (value.latestError === undefined ||
      (isRecord(value.latestError) &&
        typeof value.latestError.code === "string" &&
        typeof value.latestError.message === "string"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedAgentEventKind(value: unknown): value is PersistedAgentEventKind {
  return (
    typeof value === "string" && (PERSISTED_AGENT_EVENT_KINDS as readonly string[]).includes(value)
  );
}

function isToolStatus(value: unknown): value is ToolActivityProjection["status"] {
  return ["queued", "approval-required", "running", "succeeded", "failed", "cancelled"].includes(
    value as string,
  );
}

function isRunStatus(value: unknown): value is RunProjection["status"] {
  return ["running", "completed", "cancelled", "failed"].includes(value as string);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateThreadId(value: string): void {
  validateIdentifier(value, "threadId", MAX_THREAD_ID_LENGTH);
}

function validateIdentifier(value: string, name: string, maxLength: number, uuid = false): void {
  if (!isValidIdentifier(value, maxLength) || (uuid && !UUID_PATTERN.test(value))) {
    throw new EventStoreValidationError(`invalid ${name}`);
  }
}

function isValidIdentifier(value: string, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    THREAD_ID_PATTERN.test(value)
  );
}

function getNextSequence(events: readonly PersistedAgentEvent[]): number {
  const max = events.reduce((current, event) => Math.max(current, event.sequence), 0);
  if (max >= Number.MAX_SAFE_INTEGER)
    throw new EventStoreValidationError("event sequence exhausted");
  return max + 1;
}

function limitText(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH)}…`;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
