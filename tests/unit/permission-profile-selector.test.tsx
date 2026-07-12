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
  it("renders the current profile label and accessibility attributes", () => {
    const html = renderToString(
      h(PermissionProfileSelector, {
        state,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="権限プロファイル選択"');
    expect(html).toContain("確認あり");
    expect(html).toContain("codicon-shield");
    expect(html).toContain("codicon-chevron-down");
    expect(html).not.toContain("autonomous");
  });

  it("shows the current profile label in Restricted Mode", () => {
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

    expect(html).toContain("確認あり");
    expect(html).toContain("codicon-shield");
  });
});
