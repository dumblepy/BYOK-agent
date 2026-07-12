import { describe, expect, it } from "vitest";

import { MAX_MARKDOWN_LENGTH, parseMarkdown } from "../../src/ui/webview/markdown/MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("parses headings, inline formatting, lists, and fenced code", () => {
    const blocks = parseMarkdown(
      [
        "# 見出し",
        "",
        "本文 **強調** `const x = 1` [公式](https://example.com)",
        "",
        "- 一つ目",
        "- 二つ目",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    );

    expect(blocks).toMatchObject([
      { kind: "heading", level: 1 },
      { kind: "paragraph" },
      { kind: "unordered-list", items: [{}, {}] },
      { kind: "code", language: "ts", value: "const value = 1;" },
    ]);
  });

  it("keeps raw HTML as text and does not create dangerous links", () => {
    const blocks = parseMarkdown(
      '<script>alert("x")</script> [実行](javascript:alert(1)) [data](data:text/html,evil) [command](command:run)',
    );
    const serialized = JSON.stringify(blocks);

    expect(serialized).toContain("<script>alert");
    expect(serialized).toContain("javascript:alert(1)");
    expect(serialized).not.toContain('"kind":"link"');
  });

  it("preserves an unclosed code fence and caps oversized input", () => {
    const code = parseMarkdown("```\nline 1\nline 2");
    expect(code).toMatchObject([{ kind: "code", value: "line 1\nline 2" }]);

    const blocks = parseMarkdown("x".repeat(MAX_MARKDOWN_LENGTH + 10));
    expect(JSON.stringify(blocks)).toContain("本文は長すぎるため省略されました");
  });
});
