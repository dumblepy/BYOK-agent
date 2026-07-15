import type { ProviderCredentialSummary } from "../webview-protocol";

export type ProviderCredentialPhase = "loading" | "ready" | "updating" | "error";

export interface ProviderCredentialState {
  readonly phase: ProviderCredentialPhase;
  readonly providers: readonly ProviderCredentialSummary[];
  readonly pendingProviderId?: string;
  readonly errorMessage?: string;
  readonly noticeMessage?: string;
}

export type ProviderCredentialAction =
  | {
      readonly type: "credentials-updated";
      readonly providers: readonly ProviderCredentialSummary[];
    }
  | { readonly type: "operation-requested"; readonly providerId: string }
  | {
      readonly type: "operation-result";
      readonly providerId: string;
      readonly status: "succeeded" | "cancelled" | "failed";
    }
  | { readonly type: "error"; readonly message: string };

export const INITIAL_PROVIDER_CREDENTIAL_STATE: ProviderCredentialState = {
  phase: "loading",
  providers: [],
};

export function providerCredentialReducer(
  state: ProviderCredentialState,
  action: ProviderCredentialAction,
): ProviderCredentialState {
  switch (action.type) {
    case "credentials-updated":
      return { phase: "ready", providers: action.providers, errorMessage: undefined };
    case "operation-requested":
      if (state.phase === "updating") return state;
      return {
        ...state,
        phase: "updating",
        pendingProviderId: action.providerId,
        errorMessage: undefined,
        noticeMessage: undefined,
      };
    case "operation-result":
      if (state.pendingProviderId !== action.providerId) return state;
      return {
        ...state,
        phase: action.status === "failed" ? "error" : "ready",
        pendingProviderId: undefined,
        errorMessage: action.status === "failed" ? "認証情報を更新できませんでした。" : undefined,
        noticeMessage:
          action.status === "succeeded"
            ? "認証情報を更新しました。"
            : action.status === "cancelled"
              ? "操作をキャンセルしました。"
              : undefined,
      };
    case "error":
      return { ...state, phase: "error", errorMessage: action.message };
  }
}

export function getCredentialStatusLabel(status: ProviderCredentialSummary["status"]): string {
  switch (status) {
    case "configured":
      return "設定済み";
    case "not-configured":
      return "未設定";
    case "unavailable":
      return "確認できません";
  }
}
