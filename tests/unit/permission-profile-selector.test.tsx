import renderToString from "preact-render-to-string";
import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

import { PermissionProfileSelector } from "../../src/ui/webview/components/PermissionProfileSelector";

const state = {
  phase: "ready" as const,
  summary: {
    threadId: "thread-1",
    threadRevision: 2,
    requestedProfile: "confirm-writes" as const,
    effectiveProfile: "confirm-writes" as const,
    workspaceTrust: "trusted" as const,
    restrictions: [],
  },
};

describe("PermissionProfileSelector", () => {
  it("renders all user-selectable profiles and the current effective state", () => {
    const html = renderToString(
      h(PermissionProfileSelector, {
        state,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="権限プロファイル選択"');
    expect(html).toContain("書き込み時に確認");
    expect(html).toContain("実効権限: 書き込み時に確認");
    expect(html).toContain("信頼済みワークスペース");
    expect(html).not.toContain("autonomous");
    expect(html).toContain('aria-live="polite"');
  });

  it("shows Restricted Mode restrictions in the persistent status", () => {
    const html = renderToString(
      h(PermissionProfileSelector, {
        state: {
          ...state,
          summary: {
            ...state.summary,
            workspaceTrust: "restricted",
            restrictions: ["commands-disabled", "automatic-writes-disabled"],
          },
        },
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("Restricted Mode");
    expect(html).toContain("コマンド実行は無効です");
    expect(html).toContain("自動ファイル変更は無効です");
  });
});
