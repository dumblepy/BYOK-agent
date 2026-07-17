import * as vscode from "vscode";

import {
  computeContextContentHash,
  type ContextItem,
  type EditorContextMetadata,
  type SerializedPosition,
  type SerializedRange,
} from "./context-item";
import type { ContextProvider, ContextRequest } from "./context-provider";

export interface ActiveEditorSelectionSnapshot {
  readonly range: SerializedRange;
  readonly text: string;
  readonly isPrimary: boolean;
}

export interface ActiveEditorSnapshot {
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
  readonly documentRange: SerializedRange;
  readonly cursor: SerializedPosition;
  readonly selections: readonly ActiveEditorSelectionSnapshot[];
  readonly isUntitled: boolean;
  readonly isDirty: boolean;
  readonly documentVersion: number;
}

export interface ActiveEditorReader {
  read(): ActiveEditorSnapshot | undefined;
}

export interface ActiveEditorContextProviderOptions {
  readonly reader: ActiveEditorReader;
  readonly filePriority?: number;
  readonly selectionPriority?: number;
  readonly tokenEstimator?: (content: string) => number;
  readonly maxSelections?: number;
}

const DEFAULT_FILE_PRIORITY = 100;
const DEFAULT_SELECTION_PRIORITY = 200;
const DEFAULT_MAX_SELECTIONS = 256;

export class ActiveEditorContextProvider implements ContextProvider {
  public readonly id = "active-editor";
  public readonly scopes = ["turn"] as const;

  private readonly reader: ActiveEditorReader;
  private readonly filePriority: number;
  private readonly selectionPriority: number;
  private readonly tokenEstimator: (content: string) => number;
  private readonly maxSelections: number;

  public constructor(options: ActiveEditorContextProviderOptions) {
    this.reader = options.reader;
    this.filePriority = options.filePriority ?? DEFAULT_FILE_PRIORITY;
    this.selectionPriority = options.selectionPriority ?? DEFAULT_SELECTION_PRIORITY;
    this.tokenEstimator = options.tokenEstimator ?? estimateContextTokens;
    this.maxSelections = options.maxSelections ?? DEFAULT_MAX_SELECTIONS;
    if (!Number.isFinite(this.filePriority) || !Number.isFinite(this.selectionPriority)) {
      throw new ActiveEditorContextProviderConfigurationError("priorities must be finite numbers");
    }
    if (!Number.isSafeInteger(this.maxSelections) || this.maxSelections < 0) {
      throw new ActiveEditorContextProviderConfigurationError(
        "maxSelections must be a non-negative safe integer",
      );
    }
  }

  public async collect(
    request: ContextRequest,
    signal: AbortSignal,
  ): Promise<readonly ContextItem[]> {
    if (signal.aborted || request.scope !== "turn") {
      return [];
    }

    const snapshot = this.reader.read();
    if (!snapshot || signal.aborted) {
      return [];
    }

    validateSnapshot(snapshot);

    return createActiveEditorContextItems(snapshot, {
      filePriority: this.filePriority,
      selectionPriority: this.selectionPriority,
      tokenEstimator: this.tokenEstimator,
      maxSelections: this.maxSelections,
    });
  }
}

export interface ActiveEditorContextItemOptions {
  readonly filePriority?: number;
  readonly selectionPriority?: number;
  readonly tokenEstimator?: (content: string) => number;
  readonly maxSelections?: number;
}

export class ActiveEditorContextProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActiveEditorContextProviderConfigurationError";
  }
}

export class VscodeActiveEditorReader implements ActiveEditorReader {
  public read(): ActiveEditorSnapshot | undefined {
    const editor = vscode.window.activeTextEditor as VscodeActiveTextEditorLike | undefined;
    if (!editor) {
      return undefined;
    }

    const document = editor.document;
    const text = document.getText();
    const selections = readSelections(editor, document);

    return {
      uri: document.uri.toString(),
      languageId: document.languageId,
      text,
      documentRange: getDocumentRange(text),
      cursor: serializePosition(editor.selection.active),
      selections,
      isUntitled: document.isUntitled,
      isDirty: document.isDirty,
      documentVersion: document.version,
    };
  }
}

export function createActiveEditorContextItems(
  snapshot: ActiveEditorSnapshot,
  options: ActiveEditorContextItemOptions = {},
): readonly ContextItem[] {
  validateSnapshot(snapshot);
  const selections = snapshot.selections
    .filter((selection) => selection.text.length > 0)
    .slice(0, options.maxSelections ?? DEFAULT_MAX_SELECTIONS);

  const items: ContextItem[] = selections.map((selection, index) =>
    createSelectionItem(snapshot, selection, index, options),
  );
  items.push(createFileItem(snapshot, options));
  return items;
}

function validateSnapshot(snapshot: ActiveEditorSnapshot): void {
  if (
    typeof snapshot.uri !== "string" ||
    snapshot.uri.length === 0 ||
    typeof snapshot.languageId !== "string" ||
    snapshot.languageId.length === 0 ||
    snapshot.languageId.length > 256 ||
    containsControlCharacter(snapshot.languageId) ||
    typeof snapshot.text !== "string" ||
    !Number.isSafeInteger(snapshot.documentVersion) ||
    snapshot.documentVersion < 0
  ) {
    throw new ActiveEditorContextProviderConfigurationError("snapshot contains invalid metadata");
  }

  validateRange(snapshot.documentRange, "documentRange");
  if (snapshot.documentRange.start.line !== 0 || snapshot.documentRange.start.character !== 0) {
    throw new ActiveEditorContextProviderConfigurationError(
      "documentRange must start at line 0, character 0",
    );
  }
  validatePositionWithin(snapshot.cursor, snapshot.documentRange.end, "cursor");

  for (const selection of snapshot.selections) {
    if (typeof selection.text !== "string" || typeof selection.isPrimary !== "boolean") {
      throw new ActiveEditorContextProviderConfigurationError("selection contains invalid data");
    }
    validateRange(selection.range, "selection.range");
    validatePositionWithin(selection.range.start, snapshot.documentRange.end, "selection.start");
    validatePositionWithin(selection.range.end, snapshot.documentRange.end, "selection.end");
  }
}

function validateRange(range: SerializedRange, field: string): void {
  validatePosition(range.start, `${field}.start`);
  validatePosition(range.end, `${field}.end`);
  if (comparePositions(range.start, range.end) > 0) {
    throw new ActiveEditorContextProviderConfigurationError(`${field} must be ordered`);
  }
}

function validatePositionWithin(
  position: SerializedPosition,
  documentEnd: SerializedPosition,
  field: string,
): void {
  validatePosition(position, field);
  if (comparePositions(position, documentEnd) > 0) {
    throw new ActiveEditorContextProviderConfigurationError(`${field} is outside the document`);
  }
}

function validatePosition(position: SerializedPosition, field: string): void {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  ) {
    throw new ActiveEditorContextProviderConfigurationError(`${field} is invalid`);
  }
}

function comparePositions(left: SerializedPosition, right: SerializedPosition): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function createFileItem(
  snapshot: ActiveEditorSnapshot,
  options: ActiveEditorContextItemOptions,
): ContextItem {
  return {
    id: createItemId("file", snapshot, snapshot.documentRange),
    kind: "file",
    source: "active-editor",
    content: snapshot.text,
    uri: snapshot.uri,
    range: snapshot.documentRange,
    metadata: createEditorMetadata(snapshot, snapshot.cursor),
    priority: options.filePriority ?? DEFAULT_FILE_PRIORITY,
    estimatedTokens: (options.tokenEstimator ?? estimateContextTokens)(snapshot.text),
    contentHash: computeContextContentHash(snapshot.text),
    volatile: true,
    sensitive: false,
  };
}

function createSelectionItem(
  snapshot: ActiveEditorSnapshot,
  selection: ActiveEditorSelectionSnapshot,
  index: number,
  options: ActiveEditorContextItemOptions,
): ContextItem {
  return {
    id: createItemId("selection", snapshot, selection.range, index),
    kind: "selection",
    source: "active-editor-selection",
    content: selection.text,
    uri: snapshot.uri,
    range: selection.range,
    metadata: createEditorMetadata(snapshot, selection.isPrimary ? snapshot.cursor : undefined),
    priority: options.selectionPriority ?? DEFAULT_SELECTION_PRIORITY,
    estimatedTokens: (options.tokenEstimator ?? estimateContextTokens)(selection.text),
    contentHash: computeContextContentHash(selection.text),
    volatile: true,
    sensitive: false,
  };
}

function createEditorMetadata(
  snapshot: ActiveEditorSnapshot,
  cursor: SerializedPosition | undefined,
): { readonly editor: EditorContextMetadata } {
  return {
    editor: {
      languageId: snapshot.languageId,
      ...(cursor === undefined ? {} : { cursor }),
      isUntitled: snapshot.isUntitled,
      isDirty: snapshot.isDirty,
    },
  };
}

function createItemId(
  kind: "file" | "selection",
  snapshot: ActiveEditorSnapshot,
  range: SerializedRange,
  index = 0,
): string {
  const fingerprint = computeContextContentHash(
    JSON.stringify({
      kind,
      uri: snapshot.uri,
      range,
      index,
    }),
  ).slice(0, 24);
  return `active-editor:${kind}:${fingerprint}`;
}

function estimateContextTokens(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(content.length / 4));
}

function getDocumentRange(text: string): SerializedRange {
  const lines = text.split(/\r\n|\r|\n/);
  const endLine = Math.max(0, lines.length - 1);
  const endCharacter = lines[endLine]?.length ?? 0;
  return {
    start: { line: 0, character: 0 },
    end: { line: endLine, character: endCharacter },
  };
}

function readSelections(
  editor: VscodeActiveTextEditorLike,
  document: VscodeDocumentLike,
): readonly ActiveEditorSelectionSnapshot[] {
  const rawSelections =
    Array.isArray(editor.selections) && editor.selections.length > 0
      ? editor.selections
      : [editor.selection];

  return rawSelections.map((selection, index) => ({
    range: serializeRange(selection),
    text: document.getText(selection),
    isPrimary: index === 0,
  }));
}

function serializeRange(range: VscodeRangeLike): SerializedRange {
  return {
    start: serializePosition(range.start),
    end: serializePosition(range.end),
  };
}

function serializePosition(position: VscodePositionLike): SerializedPosition {
  return {
    line: position.line,
    character: position.character,
  };
}

interface VscodePositionLike {
  readonly line: number;
  readonly character: number;
}

interface VscodeRangeLike {
  readonly start: VscodePositionLike;
  readonly end: VscodePositionLike;
}

interface VscodeSelectionLike extends VscodeRangeLike {
  readonly active: VscodePositionLike;
}

interface VscodeDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly isUntitled: boolean;
  readonly isDirty: boolean;
  readonly version: number;
  getText(range?: VscodeRangeLike): string;
}

interface VscodeActiveTextEditorLike {
  readonly document: VscodeDocumentLike;
  readonly selection: VscodeSelectionLike;
  readonly selections: readonly VscodeSelectionLike[];
}
