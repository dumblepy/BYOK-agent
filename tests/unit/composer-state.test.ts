import { describe, expect, it } from "vitest";

import {
  composerReducer,
  createInitialComposerState,
  getComposerErrorMessage,
  getComposerEnterAction,
  isComposerDraftSubmittable,
  normalizeComposerDraft,
} from "../../src/ui/webview/composer-state";
import { MAX_COMPOSER_DRAFT_LENGTH } from "../../src/ui/webview-state";

describe("composer-state", () => {
  it("normalizes line endings and preserves intentional whitespace", () => {
    expect(normalizeComposerDraft("  first\r\nsecond\rthird  ")).toBe("  first\nsecond\nthird  ");
    expect(isComposerDraftSubmittable("  first\n")).toBe(true);
    expect(isComposerDraftSubmittable(" \n\t")).toBe(false);
  });

  it("supports the configured Enter shortcuts", () => {
    const base = {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    };

    expect(getComposerEnterAction(base)).toBe("submit");
    expect(getComposerEnterAction({ ...base, shiftKey: true })).toBe("newline");
    expect(getComposerEnterAction({ ...base, altKey: true })).toBe("newline");
    expect(getComposerEnterAction({ ...base, ctrlKey: true })).toBe("submit");
    expect(getComposerEnterAction({ ...base, metaKey: true })).toBe("submit");
    expect(getComposerEnterAction({ ...base, ctrlKey: true, shiftKey: true })).toBe("newline");
    expect(getComposerEnterAction({ ...base, isComposing: true })).toBe("default");
    expect(getComposerEnterAction({ ...base, key: "a" })).toBe("default");
  });

  it("moves through submit, acknowledgement, run and stop states", () => {
    let state = createInitialComposerState("調査してください");

    state = composerReducer(state, {
      type: "submit-requested",
      messageId: "message-1",
      text: "調査してください",
    });
    expect(state).toMatchObject({ phase: "submitting", draft: "" });

    state = composerReducer(state, {
      type: "run-state",
      runId: "run-1",
      state: "requesting-model",
    });
    expect(state).toMatchObject({ phase: "running", activeRunId: "run-1" });

    state = composerReducer(state, { type: "stop-requested" });
    expect(state.phase).toBe("stopping");

    state = composerReducer(state, {
      type: "run-state",
      runId: "run-1",
      state: "cancelled",
    });
    expect(state).toMatchObject({ phase: "idle", draft: "" });
  });

  it("restores a failed submission unless the user started a new draft", () => {
    let state = createInitialComposerState("失敗時に戻す");
    state = composerReducer(state, {
      type: "submit-requested",
      messageId: "message-1",
      text: "失敗時に戻す",
    });
    state = composerReducer(state, {
      type: "error",
      message: "送信に失敗しました。",
      correlationId: "message-1",
    });
    expect(state).toMatchObject({ phase: "error", draft: "失敗時に戻す" });

    state = createInitialComposerState("送信済み");
    state = composerReducer(state, {
      type: "submit-requested",
      messageId: "message-2",
      text: "送信済み",
    });
    state = composerReducer(state, { type: "draft-changed", draft: "新しい依頼" });
    state = composerReducer(state, {
      type: "error",
      message: "送信に失敗しました。",
      correlationId: "message-2",
    });
    expect(state).toMatchObject({ phase: "error", draft: "新しい依頼" });
  });

  it("does not adopt a draft over the configured limit", () => {
    const state = createInitialComposerState("短い依頼");
    const nextState = composerReducer(state, {
      type: "draft-changed",
      draft: "x".repeat(MAX_COMPOSER_DRAFT_LENGTH + 1),
    });

    expect(nextState.draft).toBe("短い依頼");
    expect(nextState.errorMessage).toContain("100,000");
  });

  it("maps Host error codes to safe user-facing messages", () => {
    expect(getComposerErrorMessage("PROVIDER_BAD_REQUEST")).toContain("入力を確認");
    expect(getComposerErrorMessage("TOOL_EXECUTION_FAILED")).not.toContain("TOOL_EXECUTION_FAILED");
  });
});
