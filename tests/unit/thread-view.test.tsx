import renderToString from "preact-render-to-string";
import { h } from "preact";
import { describe, expect, it } from "vitest";

import { ThreadView, getThreadMessageLabel } from "../../src/ui/webview/components/ThreadView";

describe("ThreadView", () => {
  it("renders multiple user and assistant messages with Markdown and code", () => {
    const html = renderToString(
      h(ThreadView, {
        messages: [
          {
            id: "user-1",
            role: "user",
            text: "調査してください",
            phase: "complete",
            createdAt: 1,
          },
          {
            id: "assistant-1",
            role: "assistant",
            text: "## 結果\n\n```ts\nconst value = 1;\n```",
            phase: "complete",
            createdAt: 2,
          },
          {
            id: "user-2",
            role: "user",
            text: "続けてください",
            phase: "complete",
            createdAt: 3,
          },
        ],
      }),
    );

    expect(html).toContain("調査してください");
    expect(html).toContain("続けてください");
    expect(html).toContain("thread-message-assistant");
    expect(html).toContain("<h2>結果</h2>");
    expect(html).toContain('<code class="language-ts">const value = 1;</code>');
  });

  it("renders streaming and failed states accessibly", () => {
    const html = renderToString(
      h(ThreadView, {
        messages: [
          {
            id: "assistant-streaming",
            role: "assistant",
            text: "生成中",
            phase: "streaming",
            createdAt: 1,
          },
          {
            id: "assistant-failed",
            role: "assistant",
            text: "途中まで",
            phase: "failed",
            createdAt: 2,
            errorMessage: "処理に失敗しました。",
          },
        ],
      }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("生成中");
    expect(html).toContain('role="alert"');
    expect(html).toContain("処理に失敗しました。");
  });

  it("provides role-aware labels", () => {
    expect(
      getThreadMessageLabel({
        id: "assistant-1",
        role: "assistant",
        text: "本文",
        phase: "streaming",
        createdAt: 1,
      }),
    ).toBe("エージェントのメッセージ（生成中）");
  });
});
