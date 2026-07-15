import { describe, expect, it } from "vitest";

import {
  createInitialModelSelectorState,
  getDefaultReasoningEffort,
  modelSelectorReducer,
} from "../../src/ui/webview/model-selector-state";

const models = [
  { id: "coding-fast", label: "Coding Fast", provider: "primary" },
  { id: "coding-primary", label: "Coding Primary", provider: "primary" },
] as const;

describe("model-selector-state", () => {
  it("Copilot互換の推論強度既定値を解決する", () => {
    expect(getDefaultReasoningEffort([])).toBeUndefined();
    expect(getDefaultReasoningEffort(["low"])).toBe("low");
    expect(getDefaultReasoningEffort(["low", "medium", "high"])).toBe("high");
    expect(getDefaultReasoningEffort(["low", "medium"])).toBeUndefined();
  });

  it("accepts the current thread model list and displays the selected model", () => {
    const state = modelSelectorReducer(createInitialModelSelectorState("thread-1"), {
      type: "model-list",
      threadId: "thread-1",
      threadRevision: 3,
      models,
      selectedModelId: "coding-primary",
    });

    expect(state).toMatchObject({
      phase: "ready",
      threadId: "thread-1",
      threadRevision: 3,
      selectedModelId: "coding-primary",
    });
  });

  it("ignores another thread, stale revisions, and invalid selected IDs", () => {
    const ready = modelSelectorReducer(createInitialModelSelectorState("thread-1"), {
      type: "model-list",
      threadId: "thread-1",
      threadRevision: 3,
      models,
      selectedModelId: "coding-primary",
    });

    expect(
      modelSelectorReducer(ready, {
        type: "model-list",
        threadId: "thread-2",
        threadRevision: 4,
        models,
        selectedModelId: "coding-fast",
      }),
    ).toBe(ready);
    expect(
      modelSelectorReducer(ready, {
        type: "model-list",
        threadId: "thread-1",
        threadRevision: 2,
        models,
        selectedModelId: "coding-fast",
      }),
    ).toBe(ready);
    expect(
      modelSelectorReducer(ready, {
        type: "model-list",
        threadId: "thread-1",
        threadRevision: 4,
        models,
        selectedModelId: "unknown-model",
      }),
    ).toBe(ready);
  });

  it("prevents duplicate selection and only accepts a correlated error", () => {
    const ready = modelSelectorReducer(createInitialModelSelectorState("thread-1"), {
      type: "model-list",
      threadId: "thread-1",
      threadRevision: 1,
      models,
      selectedModelId: "coding-primary",
    });
    const selecting = modelSelectorReducer(ready, {
      type: "selection-requested",
      modelId: "coding-fast",
      requestId: "request-1",
    });

    expect(selecting.phase).toBe("selecting");
    expect(
      modelSelectorReducer(selecting, {
        type: "selection-requested",
        modelId: "coding-primary",
        requestId: "request-2",
      }),
    ).toBe(selecting);
    expect(
      modelSelectorReducer(selecting, {
        type: "selection-error",
        requestId: "request-2",
        message: "古いエラー",
      }),
    ).toBe(selecting);
    const failed = modelSelectorReducer(selecting, {
      type: "selection-error",
      requestId: "request-1",
      message: "変更できませんでした",
    });
    expect(failed).toMatchObject({ phase: "error", selectedModelId: "coding-primary" });
    expect(
      modelSelectorReducer(failed, {
        type: "selection-requested",
        modelId: "coding-primary",
        requestId: "request-3",
      }),
    ).toMatchObject({ phase: "selecting", pendingRequestId: "request-3" });
  });
});
