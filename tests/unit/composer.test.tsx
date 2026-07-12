import renderToString from "preact-render-to-string";
import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/ui/webview/components/Composer";
import { createInitialComposerState, composerReducer } from "../../src/ui/webview/composer-state";
import { INITIAL_MODEL_SELECTOR_STATE } from "../../src/ui/webview/model-selector-state";

const defaultModelSelectorState = INITIAL_MODEL_SELECTOR_STATE;

describe("Composer", () => {
  it("renders a multiline input, character count, and send affordance", () => {
    const state = createInitialComposerState("調査してください\n結果をまとめてください");
    const html = renderToString(
      h(Composer, {
        state,
        modelSelectorState: defaultModelSelectorState,
        onDraftChange: vi.fn(),
        onSubmit: vi.fn(),
        onStop: vi.fn(),
        onModelSelect: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="メッセージ入力"');
    expect(html).toContain('rows="4"');
    expect(html).toContain("調査してください");
    expect(html).toContain("メッセージを送信");
  });

  it("renders the running and stopping controls accessibly", () => {
    let state = createInitialComposerState("実行する依頼");
    state = composerReducer(state, {
      type: "submit-requested",
      messageId: "message-1",
      text: "実行する依頼",
    });
    state = composerReducer(state, {
      type: "run-state",
      runId: "run-1",
      state: "executing-tools",
    });

    const html = renderToString(
      h(Composer, {
        state,
        modelSelectorState: defaultModelSelectorState,
        onDraftChange: vi.fn(),
        onSubmit: vi.fn(),
        onStop: vi.fn(),
        onModelSelect: vi.fn(),
      }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="エージェントを停止"');
    expect(html).toContain("エージェントが実行中です。");
    expect(html).toContain(" disabled");
  });

  it("renders correlated errors without exposing internal details", () => {
    const state = {
      ...createInitialComposerState("依頼"),
      phase: "error" as const,
      errorMessage: "メッセージを送信できませんでした。",
    };
    const html = renderToString(
      h(Composer, {
        state,
        modelSelectorState: defaultModelSelectorState,
        onDraftChange: vi.fn(),
        onSubmit: vi.fn(),
        onStop: vi.fn(),
        onModelSelect: vi.fn(),
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("メッセージを送信できませんでした。");
    expect(html).not.toContain("Authorization");
  });
});
