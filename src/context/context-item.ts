import { createHash } from "node:crypto";

export type ContextItemKind =
  | "instruction"
  | "workspace"
  | "file"
  | "selection"
  | "symbol"
  | "diagnostic"
  | "git"
  | "tool-result"
  | "conversation-summary";

export interface SerializedPosition {
  readonly line: number;
  readonly character: number;
}

export interface SerializedRange {
  readonly start: SerializedPosition;
  readonly end: SerializedPosition;
}

export interface EditorContextMetadata {
  readonly languageId: string;
  readonly cursor?: SerializedPosition;
  readonly isUntitled: boolean;
  readonly isDirty: boolean;
}

export interface ContextItemMetadata {
  readonly editor?: EditorContextMetadata;
}

export interface ContextItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly source: string;
  readonly content: string;
  readonly uri?: string;
  readonly range?: SerializedRange;
  readonly metadata?: ContextItemMetadata;
  readonly priority: number;
  readonly estimatedTokens: number;
  readonly contentHash: string;
  readonly volatile: boolean;
  readonly sensitive: boolean;
}

const CONTEXT_ITEM_KEYS = new Set([
  "id",
  "kind",
  "source",
  "content",
  "uri",
  "range",
  "metadata",
  "priority",
  "estimatedTokens",
  "contentHash",
  "volatile",
  "sensitive",
]);

const CONTEXT_ITEM_KINDS = new Set<ContextItemKind>([
  "instruction",
  "workspace",
  "file",
  "selection",
  "symbol",
  "diagnostic",
  "git",
  "tool-result",
  "conversation-summary",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNSAFE_URI_PROTOCOLS = new Set(["command:", "data:", "javascript:", "vbscript:"]);

export class ContextItemValidationError extends Error {
  readonly code = "invalid-context-item";

  constructor(message: string) {
    super(message);
    this.name = "ContextItemValidationError";
  }
}

export function computeContextContentHash(content: string): string {
  return createHash("sha256").update(new TextEncoder().encode(content)).digest("hex");
}

export function parseContextItem(input: unknown): ContextItem {
  if (!isRecord(input)) {
    throw new ContextItemValidationError("ContextItem must be an object");
  }

  for (const key of Object.keys(input)) {
    if (!CONTEXT_ITEM_KEYS.has(key)) {
      throw new ContextItemValidationError(`unknown ContextItem property: ${key}`);
    }
  }

  const id = requireSafeIdentifier(input.id, "id");
  const kind = requireKind(input.kind);
  const source = requireSafeIdentifier(input.source, "source");
  const content = requireString(input.content, "content");
  const uri = input.uri === undefined ? undefined : requireUri(input.uri);
  const range = input.range === undefined ? undefined : parseRange(input.range);
  const metadata = input.metadata === undefined ? undefined : parseMetadata(input.metadata);
  const priority = requireFiniteNumber(input.priority, "priority");
  const estimatedTokens = requireFiniteNumber(input.estimatedTokens, "estimatedTokens");
  if (estimatedTokens < 0) {
    throw new ContextItemValidationError("estimatedTokens must be non-negative");
  }
  const contentHash = requireString(input.contentHash, "contentHash");
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new ContextItemValidationError("contentHash must be a lowercase SHA-256 hex string");
  }
  if (contentHash !== computeContextContentHash(content)) {
    throw new ContextItemValidationError("contentHash does not match content");
  }
  const volatile = requireBoolean(input.volatile, "volatile");
  const sensitive = requireBoolean(input.sensitive, "sensitive");

  return {
    id,
    kind,
    source,
    content,
    ...(uri === undefined ? {} : { uri }),
    ...(range === undefined ? {} : { range }),
    ...(metadata === undefined ? {} : { metadata }),
    priority,
    estimatedTokens,
    contentHash,
    volatile,
    sensitive,
  };
}

export function isContextItem(input: unknown): input is ContextItem {
  try {
    parseContextItem(input);
    return true;
  } catch {
    return false;
  }
}

function parseRange(input: unknown): SerializedRange {
  if (!isRecord(input)) {
    throw new ContextItemValidationError("range must be an object");
  }
  if (!hasOnlyKeys(input, ["start", "end"])) {
    throw new ContextItemValidationError("range contains an unknown property");
  }

  const start = parsePosition(input.start, "range.start");
  const end = parsePosition(input.end, "range.end");
  if (comparePositions(start, end) > 0) {
    throw new ContextItemValidationError("range.start must not be after range.end");
  }
  return { start, end };
}

function parseMetadata(input: unknown): ContextItemMetadata {
  if (!isRecord(input)) {
    throw new ContextItemValidationError("metadata must be an object");
  }
  if (!hasOnlyKeys(input, ["editor"])) {
    throw new ContextItemValidationError("metadata contains an unknown property");
  }

  const editor = input.editor === undefined ? undefined : parseEditorMetadata(input.editor);
  return editor === undefined ? {} : { editor };
}

function parseEditorMetadata(input: unknown): EditorContextMetadata {
  if (!isRecord(input)) {
    throw new ContextItemValidationError("metadata.editor must be an object");
  }
  if (!hasOnlyKeys(input, ["languageId", "cursor", "isUntitled", "isDirty"])) {
    throw new ContextItemValidationError("metadata.editor contains an unknown property");
  }

  const languageId = requireSafeIdentifier(input.languageId, "metadata.editor.languageId");
  const cursor =
    input.cursor === undefined ? undefined : parsePosition(input.cursor, "metadata.editor.cursor");
  const isUntitled = requireBoolean(input.isUntitled, "metadata.editor.isUntitled");
  const isDirty = requireBoolean(input.isDirty, "metadata.editor.isDirty");

  return {
    languageId,
    ...(cursor === undefined ? {} : { cursor }),
    isUntitled,
    isDirty,
  };
}

function parsePosition(input: unknown, field: string): SerializedPosition {
  if (!isRecord(input) || !hasOnlyKeys(input, ["line", "character"])) {
    throw new ContextItemValidationError(`${field} must contain only line and character`);
  }
  const line = requireSafeInteger(input.line, `${field}.line`);
  const character = requireSafeInteger(input.character, `${field}.character`);
  if (line < 0 || character < 0) {
    throw new ContextItemValidationError(`${field} must be non-negative`);
  }
  return { line, character };
}

function comparePositions(left: SerializedPosition, right: SerializedPosition): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function requireKind(input: unknown): ContextItemKind {
  if (typeof input !== "string" || !CONTEXT_ITEM_KINDS.has(input as ContextItemKind)) {
    throw new ContextItemValidationError("kind is not a supported ContextItem kind");
  }
  return input as ContextItemKind;
}

function requireSafeIdentifier(input: unknown, field: string): string {
  const value = requireString(input, field);
  if (value.length === 0 || value.length > 256 || containsControlCharacter(value)) {
    throw new ContextItemValidationError(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function requireUri(input: unknown): string {
  const value = requireString(input, "uri");
  if (value.length === 0 || containsControlCharacter(value)) {
    throw new ContextItemValidationError("uri must be a non-empty URI without control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ContextItemValidationError("uri must be an absolute URI");
  }
  if (UNSAFE_URI_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new ContextItemValidationError("uri uses an unsafe protocol");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ContextItemValidationError("uri must not contain credentials");
  }
  return value;
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new ContextItemValidationError(`${field} must be a string`);
  }
  return input;
}

function requireBoolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") {
    throw new ContextItemValidationError(`${field} must be a boolean`);
  }
  return input;
}

function requireFiniteNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new ContextItemValidationError(`${field} must be a finite number`);
  }
  return input;
}

function requireSafeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    throw new ContextItemValidationError(`${field} must be a safe integer`);
  }
  return input;
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(input).every((key) => allowed.has(key));
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
