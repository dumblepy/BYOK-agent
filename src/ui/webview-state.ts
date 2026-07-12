export const AGENT_WEBVIEW_STATE_VERSION = 1 as const;
export const MAX_COMPOSER_DRAFT_LENGTH = 100_000;

export interface AgentWebviewStateV1 {
  readonly version: typeof AGENT_WEBVIEW_STATE_VERSION;
  readonly composerDraft: string;
}

export interface WebviewStateApi {
  getState<T>(): T | undefined;
  setState<T extends object>(state: T): void;
}

export interface AgentWebviewStateStore {
  readonly state: AgentWebviewStateV1;
  setComposerDraft(draft: string): AgentWebviewStateV1;
}

export const INITIAL_AGENT_WEBVIEW_STATE: AgentWebviewStateV1 = {
  version: AGENT_WEBVIEW_STATE_VERSION,
  composerDraft: "",
};

export function parseAgentWebviewState(value: unknown): AgentWebviewStateV1 {
  if (!isRecord(value)) {
    return INITIAL_AGENT_WEBVIEW_STATE;
  }

  if (
    value.version !== AGENT_WEBVIEW_STATE_VERSION ||
    typeof value.composerDraft !== "string" ||
    value.composerDraft.length > MAX_COMPOSER_DRAFT_LENGTH
  ) {
    return INITIAL_AGENT_WEBVIEW_STATE;
  }

  return {
    version: AGENT_WEBVIEW_STATE_VERSION,
    composerDraft: value.composerDraft,
  };
}

export function createAgentWebviewStateStore(api: WebviewStateApi): AgentWebviewStateStore {
  let state = parseAgentWebviewState(api.getState<unknown>());

  return {
    get state() {
      return state;
    },
    setComposerDraft(draft: string): AgentWebviewStateV1 {
      state = parseAgentWebviewState({
        version: AGENT_WEBVIEW_STATE_VERSION,
        composerDraft: draft,
      });
      api.setState(state);
      return state;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
