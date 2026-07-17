import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: undefined,
  },
}));

import * as vscode from "vscode";

import {
  ActiveEditorContextProvider,
  VscodeActiveEditorReader,
  createActiveEditorContextItems,
  type ActiveEditorSnapshot,
} from "../../src/context/active-editor-context-provider";
import { computeContextContentHash, parseContextItem } from "../../src/context/context-item";

afterEach(() => {
  vi.restoreAllMocks();
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
});

describe("ActiveEditorContextProvider", () => {
  it("returns non-empty selections before the active file and preserves metadata", async () => {
    const snapshot = createSnapshot({
      uri: "file:///workspace/src/index.ts",
      languageId: "typescript",
      text: "abc\ndefg",
      cursor: { line: 0, character: 1 },
      documentVersion: 12,
      selections: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          text: "abc",
          isPrimary: true,
        },
        {
          range: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 3 },
          },
          text: "ef",
          isPrimary: false,
        },
        {
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 4 },
          },
          text: "",
          isPrimary: false,
        },
      ],
    });
    const provider = new ActiveEditorContextProvider({
      reader: { read: () => snapshot },
    });

    const items = await provider.collect(
      { threadId: "thread-1", scope: "turn" },
      new AbortController().signal,
    );

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.kind)).toEqual(["selection", "selection", "file"]);
    expect(items.map((item) => item.priority)).toEqual([200, 200, 100]);
    expect(items[0].content).toBe("abc");
    expect(items[1].content).toBe("ef");
    expect(items[2].content).toBe("abc\ndefg");
    expect(items[2].metadata).toMatchObject({
      editor: {
        languageId: "typescript",
        cursor: { line: 0, character: 1 },
        isUntitled: false,
        isDirty: false,
      },
    });
    expect(items[0].metadata).toMatchObject({
      editor: {
        languageId: "typescript",
        cursor: { line: 0, character: 1 },
        isUntitled: false,
        isDirty: false,
      },
    });
    expect(items[1].metadata).toMatchObject({
      editor: {
        languageId: "typescript",
        isUntitled: false,
        isDirty: false,
      },
    });
    expect(parseContextItem(items[0])).toEqual(items[0]);
    expect(parseContextItem(items[1])).toEqual(items[1]);
    expect(parseContextItem(items[2])).toEqual(items[2]);
    expect(items[2].contentHash).toBe(computeContextContentHash("abc\ndefg"));
  });

  it("supports untitled documents without filesystem assumptions", async () => {
    const snapshot = createSnapshot({
      uri: "untitled:Untitled-1",
      languageId: "plaintext",
      text: "draft",
      cursor: { line: 0, character: 5 },
      isUntitled: true,
      isDirty: true,
      selections: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          text: "draft",
          isPrimary: true,
        },
      ],
    });

    const items = createActiveEditorContextItems(snapshot);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "file",
      uri: "untitled:Untitled-1",
      metadata: {
        editor: {
          languageId: "plaintext",
          cursor: { line: 0, character: 5 },
          isUntitled: true,
          isDirty: true,
        },
      },
    });
  });

  it("returns an empty collection when there is no active text editor", async () => {
    const provider = new ActiveEditorContextProvider({
      reader: { read: () => undefined },
    });

    await expect(
      provider.collect({ threadId: "thread-1", scope: "turn" }, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("rejects a selection outside the document atomically", async () => {
    const snapshot = createSnapshot({
      uri: "file:///workspace/index.ts",
      languageId: "typescript",
      text: "abc",
      cursor: { line: 0, character: 1 },
      selections: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
          text: "abc",
          isPrimary: true,
        },
      ],
    });
    const provider = new ActiveEditorContextProvider({ reader: { read: () => snapshot } });

    await expect(
      provider.collect({ threadId: "thread-1", scope: "turn" }, new AbortController().signal),
    ).rejects.toThrow("outside the document");
  });

  it("uses the VS Code active editor snapshot adapter", () => {
    const text = "alpha\nbeta";
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: {
        uri: { toString: () => "file:///workspace/src/index.ts" },
        languageId: "typescript",
        isUntitled: false,
        isDirty: true,
        version: 7,
        getText(range?: {
          readonly start: { readonly line: number; readonly character: number };
          readonly end: { readonly line: number; readonly character: number };
        }) {
          if (!range) {
            return text;
          }
          if (
            range.start.line === 0 &&
            range.start.character === 0 &&
            range.end.line === 0 &&
            range.end.character === 5
          ) {
            return "alpha";
          }
          return "beta";
        },
      },
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        active: { line: 0, character: 5 },
      },
      selections: [
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
          active: { line: 0, character: 5 },
        },
        {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 4 },
          active: { line: 1, character: 4 },
        },
      ],
    };

    const reader = new VscodeActiveEditorReader();
    expect(reader.read()).toEqual({
      uri: "file:///workspace/src/index.ts",
      languageId: "typescript",
      text,
      documentRange: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 4 },
      },
      cursor: { line: 0, character: 5 },
      selections: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          text: "alpha",
          isPrimary: true,
        },
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 4 },
          },
          text: "beta",
          isPrimary: false,
        },
      ],
      isUntitled: false,
      isDirty: true,
      documentVersion: 7,
    });
  });
});

function createSnapshot(
  overrides: Partial<ActiveEditorSnapshot> & {
    readonly uri: string;
    readonly languageId: string;
    readonly text: string;
    readonly cursor: { readonly line: number; readonly character: number };
    readonly selections: ActiveEditorSnapshot["selections"];
  },
): ActiveEditorSnapshot {
  return {
    uri: overrides.uri,
    languageId: overrides.languageId,
    text: overrides.text,
    documentRange: overrides.documentRange ?? {
      start: { line: 0, character: 0 },
      end: {
        line: overrides.text.split(/\r\n|\r|\n/).length - 1,
        character: overrides.text.split(/\r\n|\r|\n/).at(-1)?.length ?? 0,
      },
    },
    cursor: overrides.cursor,
    selections: overrides.selections,
    isUntitled: overrides.isUntitled ?? false,
    isDirty: overrides.isDirty ?? false,
    documentVersion: overrides.documentVersion ?? 1,
  };
}
