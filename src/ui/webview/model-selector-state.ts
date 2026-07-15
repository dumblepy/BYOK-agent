import type { AgentErrorCode, ModelSummary } from "../webview-protocol";

export interface ModelCatalogDiagnosticSummary {
  readonly path: string;
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORT_OPTIONS: readonly [ReasoningEffort, string][] = [
  ["none", "なし"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "非常に高い"],
];

/** Matches Copilot's default resolution for a model's supported effort levels. */
export function getDefaultReasoningEffort(
  efforts: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (efforts.length === 1) return efforts[0];
  return efforts.includes("high") ? "high" : undefined;
}

export type ModelSelectorPhase = "loading" | "ready" | "selecting" | "error";

export interface ModelSelectorState {
  readonly phase: ModelSelectorPhase;
  readonly threadId?: string;
  readonly threadRevision?: number;
  readonly models: readonly ModelSummary[];
  readonly selectedModelId?: string;
  readonly pendingModelId?: string;
  readonly pendingRequestId?: string;
  readonly errorMessage?: string;
  readonly diagnostics: readonly ModelCatalogDiagnosticSummary[];
}

export type ModelSelectorAction =
  | { readonly type: "thread-changed"; readonly threadId: string; readonly threadRevision: number }
  | {
      readonly type: "model-list";
      readonly threadId: string;
      readonly threadRevision: number;
      readonly models: readonly ModelSummary[];
      readonly selectedModelId?: string;
      readonly diagnostics?: readonly ModelCatalogDiagnosticSummary[];
    }
  | {
      readonly type: "selection-requested";
      readonly modelId: string;
      readonly requestId: string;
    }
  | {
      readonly type: "selection-error";
      readonly message: string;
      readonly requestId?: string;
    };

export const INITIAL_MODEL_SELECTOR_STATE: ModelSelectorState = {
  phase: "loading",
  models: [],
  diagnostics: [],
};

export function createInitialModelSelectorState(threadId?: string): ModelSelectorState {
  return {
    ...INITIAL_MODEL_SELECTOR_STATE,
    ...(threadId ? { threadId } : {}),
  };
}

export function modelSelectorReducer(
  state: ModelSelectorState,
  action: ModelSelectorAction,
): ModelSelectorState {
  switch (action.type) {
    case "thread-changed":
      if (state.threadId === action.threadId && state.threadRevision === action.threadRevision) {
        return state;
      }
      return {
        phase: "loading",
        threadId: action.threadId,
        threadRevision: action.threadRevision,
        models: [],
        diagnostics: [],
      };
    case "model-list":
      if (state.threadId !== undefined && state.threadId !== action.threadId) {
        return state;
      }
      if (state.threadRevision !== undefined && action.threadRevision < state.threadRevision) {
        return state;
      }
      if (
        action.selectedModelId !== undefined &&
        !action.models.some((model) => model.id === action.selectedModelId)
      ) {
        return state;
      }
      return {
        phase: "ready",
        threadId: action.threadId,
        threadRevision: action.threadRevision,
        models: action.models,
        diagnostics: action.diagnostics ?? [],
        ...(action.selectedModelId ? { selectedModelId: action.selectedModelId } : {}),
      };
    case "selection-requested":
      if (
        (state.phase !== "ready" && state.phase !== "error") ||
        state.threadRevision === undefined ||
        !state.models.some((model) => model.id === action.modelId)
      ) {
        return state;
      }
      return {
        ...state,
        phase: "selecting",
        pendingModelId: action.modelId,
        pendingRequestId: action.requestId,
        errorMessage: undefined,
      };
    case "selection-error":
      if (action.requestId !== undefined && action.requestId !== state.pendingRequestId) {
        return state;
      }
      return {
        ...state,
        phase: "error",
        pendingModelId: undefined,
        pendingRequestId: undefined,
        errorMessage: action.message,
      };
  }
}

export function getSelectedModelLabel(state: ModelSelectorState): string {
  if (state.selectedModelId === undefined) {
    return "モデル未選択";
  }

  return state.models.find((model) => model.id === state.selectedModelId)?.label ?? "モデル未選択";
}

export function getModelSelectorStatusLabel(state: ModelSelectorState): string {
  switch (state.phase) {
    case "loading":
      return "モデル一覧を読み込んでいます。";
    case "ready":
      return state.models.length > 0
        ? (state.diagnostics ?? []).length > 0
          ? `現在のモデル: ${getSelectedModelLabel(state)}（設定に警告があります）`
          : `現在のモデル: ${getSelectedModelLabel(state)}`
        : "利用可能なモデルがありません。";
    case "selecting":
      return "モデルを変更しています。";
    case "error":
      return state.errorMessage ?? "モデルの変更に失敗しました。";
  }
}

export function getModelSelectorErrorMessage(code: AgentErrorCode): string {
  switch (code) {
    case "MODEL_NOT_FOUND":
      return "選択したモデルは利用できません。モデル一覧を更新してください。";
    case "MODEL_SELECTION_CONFLICT":
      return "モデル一覧が更新されています。最新の状態を確認してください。";
    case "MODEL_SELECTION_BUSY":
      return "実行中はモデルを変更できません。処理の完了後に再試行してください。";
    case "MODEL_NOT_SELECTED":
      return "モデルを選択してから送信してください。";
    default:
      return "モデルの変更に失敗しました。再試行してください。";
  }
}
