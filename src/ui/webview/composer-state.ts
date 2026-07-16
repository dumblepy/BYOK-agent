import { MAX_COMPOSER_DRAFT_LENGTH } from "../webview-state";
import type { AgentErrorCode, AgentRuntimeState } from "../webview-protocol";

export type ComposerPhase = "idle" | "inputting" | "submitting" | "running" | "stopping" | "error";

export interface ComposerState {
  readonly phase: ComposerPhase;
  readonly draft: string;
  readonly activeRunId?: string;
  readonly errorMessage?: string;
  readonly pendingMessageId?: string;
  readonly pendingText?: string;
  readonly draftRevision: number;
  readonly pendingDraftRevision?: number;
}

export type ComposerAction =
  | { readonly type: "draft-changed"; readonly draft: string }
  | { readonly type: "draft-rejected"; readonly message: string }
  | {
      readonly type: "submit-requested";
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: "message-accepted";
      readonly messageId: string;
    }
  | {
      readonly type: "run-state";
      readonly runId: string;
      readonly state: AgentRuntimeState;
    }
  | { readonly type: "stop-requested" }
  | {
      readonly type: "error";
      readonly message: string;
      readonly correlationId?: string;
    }
  | { readonly type: "clear-error" };

export const INITIAL_COMPOSER_STATE: ComposerState = createInitialComposerState("");

export function createInitialComposerState(draft: string): ComposerState {
  const normalizedDraft = normalizeComposerDraft(draft);
  if (!isComposerDraftWithinLimit(normalizedDraft)) {
    return INITIAL_COMPOSER_STATE;
  }

  return {
    phase: getDraftPhase(normalizedDraft),
    draft: normalizedDraft,
    draftRevision: 0,
  };
}

export function normalizeComposerDraft(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function isComposerDraftWithinLimit(value: string): boolean {
  return value.length <= MAX_COMPOSER_DRAFT_LENGTH;
}

export function isComposerDraftSubmittable(value: string): boolean {
  return value.trim().length > 0 && isComposerDraftWithinLimit(value);
}

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "draft-changed": {
      const draft = normalizeComposerDraft(action.draft);
      if (!isComposerDraftWithinLimit(draft)) {
        return {
          ...state,
          errorMessage: `入力は${MAX_COMPOSER_DRAFT_LENGTH.toLocaleString()}文字以内にしてください。`,
        };
      }

      return {
        phase: getDraftPhase(draft),
        draft,
        ...(state.pendingMessageId !== undefined
          ? {
              pendingMessageId: state.pendingMessageId,
              pendingText: state.pendingText,
              pendingDraftRevision: state.pendingDraftRevision,
            }
          : {}),
        draftRevision: state.draftRevision + 1,
      };
    }
    case "draft-rejected":
      return {
        ...state,
        errorMessage: action.message,
      };
    case "submit-requested": {
      if (!isComposerDraftSubmittable(state.draft)) {
        return state;
      }

      const draftRevision = state.draftRevision + 1;
      return {
        phase: "submitting",
        draft: "",
        pendingMessageId: action.messageId,
        pendingText: action.text,
        draftRevision,
        pendingDraftRevision: draftRevision,
      };
    }
    case "message-accepted":
      if (state.pendingMessageId !== action.messageId) {
        return state;
      }

      return {
        phase: getDraftPhase(state.draft),
        draft: state.draft,
        draftRevision: state.draftRevision,
      };
    case "run-state":
      return reduceRunState(state, action.runId, action.state);
    case "stop-requested":
      return state.phase === "running" && state.activeRunId
        ? { ...state, phase: "stopping", errorMessage: undefined }
        : state;
    case "error":
      if (action.correlationId !== undefined && action.correlationId !== state.pendingMessageId) {
        return state;
      }

      return restorePendingDraftOnError(state, action.message);
    case "clear-error":
      return {
        ...state,
        errorMessage: undefined,
        phase: getDraftPhase(state.draft),
      };
  }
}

export type ComposerEnterAction = "submit" | "newline" | "default";

export interface ComposerKeyEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
}

export function getComposerEnterAction(event: ComposerKeyEventLike): ComposerEnterAction {
  if (event.key !== "Enter" || event.isComposing) {
    return "default";
  }

  if (event.shiftKey || event.altKey) {
    return "newline";
  }

  if (event.ctrlKey || event.metaKey || !event.shiftKey) {
    return "submit";
  }

  return "default";
}

export function getComposerStatusLabel(state: ComposerState): string {
  switch (state.phase) {
    case "idle":
      return "入力待ちです。";
    case "inputting":
      return "入力中です。Enterで送信できます。Shift+Enterで改行できます。";
    case "submitting":
      return "メッセージを送信中です。";
    case "running":
      return "エージェントが実行中です。";
    case "stopping":
      return "停止しています。";
    case "error":
      return state.errorMessage ?? "処理に失敗しました。再試行してください。";
  }
}

export function getComposerErrorMessage(code: AgentErrorCode): string {
  switch (code) {
    case "PROVIDER_AUTH_FAILED":
      return "モデルの認証に失敗しました。設定を確認してください。";
    case "PROVIDER_RATE_LIMITED":
      return "リクエスト制限に達しました。時間を置いて再試行してください。";
    case "PROVIDER_TIMEOUT":
      return "モデルへの接続がタイムアウトしました。再試行してください。";
    case "PROVIDER_BAD_REQUEST":
      return "メッセージを処理できませんでした。入力を確認してください。";
    case "PROVIDER_UNSUPPORTED":
      return "Providerまたはモデルが要求された機能に対応していません。";
    case "PROVIDER_NETWORK":
      return "Providerへの接続に失敗しました。再試行してください。";
    case "PROVIDER_UNKNOWN":
      return "Providerで予期しないエラーが発生しました。再試行してください。";
    case "MODEL_CONTEXT_EXCEEDED":
      return "入力が長すぎるため処理できませんでした。短くして再試行してください。";
    case "USER_CANCELLED":
      return "処理を停止しました。";
    case "WORKSPACE_NOT_TRUSTED":
      return "信頼済みワークスペースでのみ実行できます。";
    case "TOOL_PERMISSION_DENIED":
      return "必要な操作が許可されませんでした。";
    case "PATCH_CONFLICT":
      return "ファイルの競合が発生しました。内容を確認して再試行してください。";
    default:
      return "エージェントの処理に失敗しました。再試行してください。";
  }
}

function getDraftPhase(draft: string): ComposerPhase {
  return isComposerDraftSubmittable(draft) ? "inputting" : "idle";
}

function reduceRunState(
  state: ComposerState,
  runId: string,
  runState: AgentRuntimeState,
): ComposerState {
  if (isActiveRunState(runState)) {
    if (state.phase !== "submitting" && state.activeRunId !== runId) {
      return state;
    }

    return {
      ...state,
      phase: "running",
      activeRunId: runId,
      errorMessage: undefined,
    };
  }

  if (state.activeRunId !== runId) {
    return state;
  }

  if (runState === "failed") {
    return restorePendingDraftOnError(
      state,
      "エージェントの処理に失敗しました。再試行してください。",
    );
  }

  return {
    phase: "idle",
    draft: state.draft,
    draftRevision: state.draftRevision,
  };
}

function restorePendingDraftOnError(state: ComposerState, message: string): ComposerState {
  const shouldRestore =
    state.pendingText !== undefined &&
    state.pendingDraftRevision !== undefined &&
    state.draftRevision === state.pendingDraftRevision;
  const draft = shouldRestore ? state.pendingText : state.draft;

  return {
    phase: "error",
    draft,
    errorMessage: message,
    draftRevision: state.draftRevision,
  };
}

function isActiveRunState(state: AgentRuntimeState): boolean {
  return [
    "preparing-context",
    "building-prompt",
    "requesting-model",
    "waiting-for-approval",
    "executing-tools",
    "compacting-context",
    "reviewing-changes",
  ].includes(state);
}
