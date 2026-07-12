import type { AgentErrorCode } from "../webview-protocol";
import {
  isMorePermissivePermissionProfile,
  type PermissionSummary,
  type UserSelectablePermissionProfile,
} from "../../permissions/permission-profile";

export type PermissionSelectorPhase = "loading" | "ready" | "confirming" | "updating" | "error";

export interface PermissionSelectorState {
  readonly phase: PermissionSelectorPhase;
  readonly summary?: PermissionSummary;
  readonly pendingProfile?: UserSelectablePermissionProfile;
  readonly pendingRequestId?: string;
  readonly errorMessage?: string;
}

export type PermissionSelectorAction =
  | {
      readonly type: "thread-changed";
      readonly threadId: string;
      readonly threadRevision: number;
    }
  | { readonly type: "permission-updated"; readonly summary: PermissionSummary }
  | {
      readonly type: "confirmation-requested";
      readonly profile: UserSelectablePermissionProfile;
    }
  | { readonly type: "confirmation-cancelled" }
  | {
      readonly type: "selection-requested";
      readonly profile: UserSelectablePermissionProfile;
      readonly requestId: string;
    }
  | {
      readonly type: "selection-error";
      readonly message: string;
      readonly requestId?: string;
    };

export const INITIAL_PERMISSION_SELECTOR_STATE: PermissionSelectorState = {
  phase: "loading",
};

export function createInitialPermissionSelectorState(threadId?: string): PermissionSelectorState {
  void threadId;
  return { ...INITIAL_PERMISSION_SELECTOR_STATE };
}

export function permissionSelectorReducer(
  state: PermissionSelectorState,
  action: PermissionSelectorAction,
): PermissionSelectorState {
  switch (action.type) {
    case "thread-changed":
      if (state.summary?.threadId === action.threadId) {
        return state.summary.threadRevision === action.threadRevision
          ? state
          : { phase: "loading" };
      }
      return { phase: "loading" };
    case "permission-updated":
      if (state.summary && state.summary.threadId !== action.summary.threadId) {
        return state;
      }
      if (state.summary && action.summary.threadRevision < state.summary.threadRevision) {
        return state;
      }
      return {
        phase: "ready",
        summary: action.summary,
      };
    case "confirmation-requested":
      if (!canChooseProfile(state, action.profile)) {
        return state;
      }
      return {
        ...state,
        phase: "confirming",
        pendingProfile: action.profile,
        errorMessage: undefined,
      };
    case "confirmation-cancelled":
      if (state.phase !== "confirming") {
        return state;
      }
      return {
        ...state,
        phase: "ready",
        pendingProfile: undefined,
      };
    case "selection-requested":
      if (
        !canChooseProfile(state, action.profile) &&
        !(state.phase === "confirming" && state.pendingProfile === action.profile)
      ) {
        return state;
      }
      return {
        ...state,
        phase: "updating",
        pendingProfile: action.profile,
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
        pendingProfile: undefined,
        pendingRequestId: undefined,
        errorMessage: action.message,
      };
  }
}

export function canChooseProfile(
  state: PermissionSelectorState,
  profile: UserSelectablePermissionProfile,
): boolean {
  return (
    (state.phase === "ready" || state.phase === "error") &&
    state.summary !== undefined &&
    state.summary.requestedProfile !== profile
  );
}

export function requiresPermissionConfirmation(
  current: UserSelectablePermissionProfile,
  next: UserSelectablePermissionProfile,
): boolean {
  return isMorePermissivePermissionProfile(current, next);
}

export function getPermissionProfileLabel(profile: UserSelectablePermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "読み取り";
    case "confirm-writes":
      return "確認あり";
    case "workspace-write":
      return "書き込み";
  }
}

export function getPermissionProfileDescription(profile: UserSelectablePermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "閲覧のみ。編集・実行不可。";
    case "confirm-writes":
      return "変更前に確認します。";
    case "workspace-write":
      return "変更を自動で進めます。";
  }
}

export function getPermissionRestrictionLabel(
  restriction: PermissionSummary["restrictions"][number],
): string {
  switch (restriction) {
    case "commands-disabled":
      return "コマンド不可";
    case "automatic-writes-disabled":
      return "自動編集不可";
    case "workspace-provider-disabled":
      return "外部モデル不可";
    case "workspace-mcp-disabled":
      return "MCP不可";
  }
}

export function getPermissionStatusLabel(state: PermissionSelectorState): string {
  switch (state.phase) {
    case "loading":
      return "読み込み中...";
    case "confirming":
      return "確認してください。";
    case "updating":
      return "変更中...";
    case "error":
      return state.errorMessage ?? "変更に失敗しました。";
    case "ready":
      return state.summary
        ? `${getPermissionProfileLabel(state.summary.requestedProfile)}`
        : "確認できません。";
  }
}

export function getPermissionErrorMessage(code: AgentErrorCode): string {
  switch (code) {
    case "PERMISSION_SELECTION_CONFLICT":
      return "権限状態が更新されています。最新の状態を確認してください。";
    case "PERMISSION_SELECTION_BUSY":
      return "実行中は権限を変更できません。処理の完了後に再試行してください。";
    case "PERMISSION_PROFILE_NOT_ALLOWED":
    case "WORKSPACE_NOT_TRUSTED":
      return "現在のワークスペースでは選択した権限を利用できません。";
    default:
      return "権限の変更に失敗しました。再試行してください。";
  }
}
