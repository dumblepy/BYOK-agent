import { describe, expect, it } from "vitest";

import {
  createInitialPermissionSelectorState,
  getPermissionProfileLabel,
  permissionSelectorReducer,
  requiresPermissionConfirmation,
} from "../../src/ui/webview/permission-profile-state";

const summary = {
  threadId: "thread-1",
  threadRevision: 2,
  requestedProfile: "read-only" as const,
  effectiveProfile: "read-only" as const,
  workspaceTrust: "trusted" as const,
  restrictions: [],
};

describe("permission-profile-state", () => {
  it("keeps permission selection pending until Host confirms it", () => {
    const ready = permissionSelectorReducer(createInitialPermissionSelectorState("thread-1"), {
      type: "permission-updated",
      summary,
    });
    const confirming = permissionSelectorReducer(ready, {
      type: "confirmation-requested",
      profile: "workspace-write",
    });

    expect(confirming).toMatchObject({
      phase: "confirming",
      summary,
      pendingProfile: "workspace-write",
    });

    const updating = permissionSelectorReducer(confirming, {
      type: "selection-requested",
      profile: "workspace-write",
      requestId: "request-1",
    });
    expect(updating).toMatchObject({ phase: "updating", pendingRequestId: "request-1" });

    const confirmed = permissionSelectorReducer(updating, {
      type: "permission-updated",
      summary: {
        ...summary,
        threadRevision: 3,
        requestedProfile: "workspace-write",
        effectiveProfile: "workspace-write",
      },
    });
    expect(confirmed).toMatchObject({
      phase: "ready",
      summary: { requestedProfile: "workspace-write", threadRevision: 3 },
    });
  });

  it("ignores stale or different-thread summaries and preserves the confirmed state on errors", () => {
    const ready = permissionSelectorReducer(createInitialPermissionSelectorState("thread-1"), {
      type: "permission-updated",
      summary,
    });
    expect(
      permissionSelectorReducer(ready, {
        type: "permission-updated",
        summary: { ...summary, threadId: "thread-2", threadRevision: 3 },
      }),
    ).toBe(ready);
    expect(
      permissionSelectorReducer(ready, {
        type: "permission-updated",
        summary: { ...summary, threadRevision: 1 },
      }),
    ).toBe(ready);

    const selecting = permissionSelectorReducer(ready, {
      type: "selection-requested",
      profile: "confirm-writes",
      requestId: "request-1",
    });
    const error = permissionSelectorReducer(selecting, {
      type: "selection-error",
      requestId: "request-1",
      message: "変更できませんでした",
    });
    expect(error).toMatchObject({ phase: "error", summary, errorMessage: "変更できませんでした" });
  });

  it("requires confirmation only when permission expands", () => {
    expect(requiresPermissionConfirmation("read-only", "confirm-writes")).toBe(true);
    expect(requiresPermissionConfirmation("confirm-writes", "workspace-write")).toBe(true);
    expect(requiresPermissionConfirmation("workspace-write", "read-only")).toBe(false);
    expect(getPermissionProfileLabel("read-only")).toBe("読み取り");
  });
});
