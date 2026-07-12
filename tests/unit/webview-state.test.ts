import { describe, expect, it, vi } from "vitest";

import {
  AGENT_WEBVIEW_STATE_VERSION,
  INITIAL_AGENT_WEBVIEW_STATE,
  MAX_COMPOSER_DRAFT_LENGTH,
  createAgentWebviewStateStore,
  parseAgentWebviewState,
} from "../../src/ui/webview-state";

describe("parseAgentWebviewState", () => {
  it("accepts the current state version and discards unknown fields", () => {
    expect(
      parseAgentWebviewState({
        version: AGENT_WEBVIEW_STATE_VERSION,
        composerDraft: "途中の依頼",
        secret: "must not be retained",
      }),
    ).toEqual({
      version: AGENT_WEBVIEW_STATE_VERSION,
      composerDraft: "途中の依頼",
    });
  });

  it.each([
    undefined,
    null,
    "state",
    [],
    {},
    { version: 2, composerDraft: "old state" },
    { version: AGENT_WEBVIEW_STATE_VERSION, composerDraft: 42 },
    {
      version: AGENT_WEBVIEW_STATE_VERSION,
      composerDraft: "x".repeat(MAX_COMPOSER_DRAFT_LENGTH + 1),
    },
  ])("falls back to the initial state for invalid input: %j", (value) => {
    expect(parseAgentWebviewState(value)).toBe(INITIAL_AGENT_WEBVIEW_STATE);
  });
});

describe("createAgentWebviewStateStore", () => {
  it("restores the draft once and persists each subsequent change", () => {
    const getState = vi.fn(() => ({
      version: AGENT_WEBVIEW_STATE_VERSION,
      composerDraft: "restored draft",
    }));
    const setState = vi.fn();
    const store = createAgentWebviewStateStore({ getState, setState });

    expect(getState).toHaveBeenCalledTimes(1);
    expect(store.state.composerDraft).toBe("restored draft");

    store.setComposerDraft("latest draft");

    expect(setState).toHaveBeenCalledWith({
      version: AGENT_WEBVIEW_STATE_VERSION,
      composerDraft: "latest draft",
    });
    expect(store.state.composerDraft).toBe("latest draft");
  });

  it("stores only the allowlisted UI state", () => {
    const setState = vi.fn();
    const store = createAgentWebviewStateStore({
      getState: () => undefined,
      setState,
    });

    store.setComposerDraft("safe draft");

    expect(setState).toHaveBeenCalledWith({
      version: AGENT_WEBVIEW_STATE_VERSION,
      composerDraft: "safe draft",
    });
    expect(setState.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    expect(setState.mock.calls[0]?.[0]).not.toHaveProperty("fileContents");
  });
});
