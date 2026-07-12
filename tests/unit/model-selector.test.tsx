import renderToString from "preact-render-to-string";
import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

import { ModelSelector } from "../../src/ui/webview/components/ModelSelector";

describe("ModelSelector", () => {
  it("renders the current model label and accessible attributes", () => {
    const html = renderToString(
      h(ModelSelector, {
        state: {
          phase: "ready",
          threadId: "thread-1",
          threadRevision: 1,
          models: [
            { id: "coding-fast", label: "Coding Fast", provider: "primary" },
            { id: "coding-primary", label: "Coding Primary", provider: "primary" },
          ],
          selectedModelId: "coding-primary",
        },
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="モデル選択"');
    expect(html).toContain("Coding Primary");
    expect(html).toContain("現在のモデル: Coding Primary");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-haspopup="true"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("disables the button while loading, selecting, or empty", () => {
    const html = renderToString(
      h(ModelSelector, {
        state: { phase: "loading", models: [] },
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain("モデル一覧を読み込んでいます。");
  });
});
