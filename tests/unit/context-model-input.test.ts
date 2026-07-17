import { describe, expect, it } from "vitest";

import { DefaultContextManager } from "../../src/context/context-model-input";
import { computeContextContentHash, type ContextItem } from "../../src/context/context-item";

function item(
  id: string,
  kind: ContextItem["kind"],
  content: string,
  priority: number,
  uri = "file:///workspace/index.ts",
): ContextItem {
  return {
    id,
    kind,
    source: id,
    content,
    uri,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: content.length },
    },
    priority,
    estimatedTokens: content.length,
    contentHash: computeContextContentHash(content),
    volatile: true,
    sensitive: false,
  };
}

describe("DefaultContextManager", () => {
  it("orders selection before file and preserves editor metadata for model input", () => {
    const selection = {
      ...item("selection", "selection", "selected", 200),
      metadata: {
        editor: {
          languageId: "typescript",
          cursor: { line: 1, character: 2 },
          isUntitled: false,
          isDirty: true,
        },
      },
    } satisfies ContextItem;
    const file = item("file", "file", "whole file", 100);

    const result = new DefaultContextManager().createModelInput({
      status: "completed",
      items: [file, selection],
      providers: [],
    });

    expect(result.items.map((context) => context.kind)).toEqual(["selection", "file"]);
    expect(result.items[0]).toMatchObject({
      content: "selected",
      metadata: selection.metadata,
    });
  });

  it("deduplicates by URI, range, and content hash, then applies the token budget", () => {
    const duplicate = item("duplicate", "file", "same", 100);
    const higherPriority = item("higher", "selection", "small", 200);
    const tooLarge = item("large", "file", "large-content", 150);

    const result = new DefaultContextManager().createModelInput(
      {
        status: "completed",
        items: [duplicate, { ...duplicate, id: "duplicate-copy" }, tooLarge, higherPriority],
        providers: [],
      },
      { maxTokens: higherPriority.estimatedTokens + duplicate.estimatedTokens },
    );

    expect(result.items.map((context) => context.id)).toEqual(["higher", "duplicate"]);
    expect(result.estimatedTokens).toBe(9);
  });

  it("does not publish partial context after cancellation", () => {
    const result = new DefaultContextManager().createModelInput({
      status: "cancelled",
      items: [item("file", "file", "secret", 100)],
      providers: [],
    });

    expect(result).toEqual({ items: [], estimatedTokens: 0 });
  });
});
