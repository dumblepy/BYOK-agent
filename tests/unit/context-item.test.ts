import { describe, expect, it } from "vitest";

import {
  computeContextContentHash,
  isContextItem,
  parseContextItem,
  type ContextItem,
  type ContextItemKind,
} from "../../src/context/context-item";

const baseItem: ContextItem = {
  id: "context-1",
  kind: "file",
  source: "active-editor",
  content: "const value = 1;\n",
  uri: "file:///workspace/src/index.ts",
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 17 },
  },
  priority: 100,
  estimatedTokens: 5,
  contentHash: computeContextContentHash("const value = 1;\n"),
  volatile: true,
  sensitive: false,
};

describe("ContextItem", () => {
  it("supports every documented kind", () => {
    const kinds: readonly ContextItemKind[] = [
      "instruction",
      "workspace",
      "file",
      "selection",
      "symbol",
      "diagnostic",
      "git",
      "tool-result",
      "conversation-summary",
    ];

    for (const kind of kinds) {
      expect(parseContextItem({ ...baseItem, kind }).kind).toBe(kind);
    }
  });

  it("accepts optional URI and range omissions", () => {
    const withoutLocation = Object.fromEntries(
      Object.entries(baseItem).filter(([key]) => key !== "uri" && key !== "range"),
    );
    expect(parseContextItem(withoutLocation)).toEqual({ ...withoutLocation });
  });

  it("accepts an empty half-open range", () => {
    expect(
      parseContextItem({
        ...baseItem,
        range: {
          start: { line: 3, character: 4 },
          end: { line: 3, character: 4 },
        },
      }).range,
    ).toEqual({
      start: { line: 3, character: 4 },
      end: { line: 3, character: 4 },
    });
  });

  it("keeps sensitive and volatile as independent flags", () => {
    for (const sensitive of [false, true]) {
      for (const volatile of [false, true]) {
        expect(parseContextItem({ ...baseItem, sensitive, volatile })).toMatchObject({
          sensitive,
          volatile,
        });
      }
    }
  });

  it("preserves typed editor metadata", () => {
    const metadata = {
      editor: {
        languageId: "typescript",
        cursor: { line: 2, character: 8 },
        isUntitled: true,
        isDirty: true,
      },
    };

    expect(parseContextItem({ ...baseItem, metadata })).toMatchObject({ metadata });
  });

  it("computes a lowercase SHA-256 hash from UTF-8 content", () => {
    expect(computeContextContentHash("日本語\n")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContextContentHash("same")).toBe(computeContextContentHash("same"));
    expect(computeContextContentHash("same")).not.toBe(computeContextContentHash("same\n"));
  });

  it("rejects unknown properties and unsupported kinds", () => {
    expect(() => parseContextItem({ ...baseItem, extra: true })).toThrow(
      "unknown ContextItem property",
    );
    expect(() => parseContextItem({ ...baseItem, kind: "message" })).toThrow(
      "supported ContextItem kind",
    );
  });

  it("rejects invalid numbers and ranges", () => {
    expect(() => parseContextItem({ ...baseItem, priority: Number.NaN })).toThrow("finite number");
    expect(() => parseContextItem({ ...baseItem, estimatedTokens: -1 })).toThrow("non-negative");
    expect(() =>
      parseContextItem({
        ...baseItem,
        range: {
          start: { line: 2, character: 0 },
          end: { line: 1, character: 10 },
        },
      }),
    ).toThrow("after range.end");
    expect(() =>
      parseContextItem({
        ...baseItem,
        range: {
          start: { line: -1, character: 0 },
          end: { line: 0, character: 0 },
        },
      }),
    ).toThrow("non-negative");
  });

  it("rejects invalid metadata", () => {
    expect(() =>
      parseContextItem({
        ...baseItem,
        metadata: {
          editor: {
            languageId: "typescript",
            cursor: { line: 0, character: 0 },
            isUntitled: false,
            isDirty: true,
            extra: true,
          },
        },
      }),
    ).toThrow("unknown property");

    expect(() =>
      parseContextItem({
        ...baseItem,
        metadata: {
          editor: {
            languageId: "",
            isUntitled: false,
            isDirty: false,
          },
        },
      }),
    ).toThrow("safe identifier");
  });

  it("rejects unsafe or credential-bearing URIs", () => {
    expect(() =>
      parseContextItem({ ...baseItem, uri: "https://user:pass@example.test/a" }),
    ).toThrow("credentials");
    expect(() => parseContextItem({ ...baseItem, uri: "javascript:alert(1)" })).toThrow(
      "unsafe protocol",
    );
    expect(() => parseContextItem({ ...baseItem, uri: "/workspace/src/index.ts" })).toThrow(
      "absolute URI",
    );
  });

  it("rejects non-SHA-256 hashes and exposes a safe type guard", () => {
    expect(() => parseContextItem({ ...baseItem, contentHash: "ABC" })).toThrow(
      "lowercase SHA-256",
    );
    expect(() => parseContextItem({ ...baseItem, contentHash: "0".repeat(64) })).toThrow(
      "does not match content",
    );
    expect(isContextItem(baseItem)).toBe(true);
    expect(isContextItem({ ...baseItem, sensitive: "yes" })).toBe(false);
  });
});
