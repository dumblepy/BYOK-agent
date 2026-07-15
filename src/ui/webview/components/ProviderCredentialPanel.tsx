import type { JSX } from "preact";

import {
  getCredentialStatusLabel,
  type ProviderCredentialState,
} from "../provider-credential-state";

export interface ProviderCredentialPanelProps {
  readonly state: ProviderCredentialState;
  readonly onSet: (providerId: string) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onClose: () => void;
}

export function ProviderCredentialPanel({
  state,
  onSet,
  onDelete,
  onClose,
}: ProviderCredentialPanelProps): JSX.Element {
  const isBusy = state.phase === "loading" || state.phase === "updating";
  return (
    <section class="provider-credentials" aria-labelledby="provider-credentials-title">
      <div class="provider-credentials-heading">
        <div>
          <h2 id="provider-credentials-title">Provider認証</h2>
          <p class="provider-credentials-description">APIキー本体は表示されません。</p>
        </div>
        <div class="provider-credentials-heading-actions">
          <i class="codicon codicon-key" aria-hidden="true" />
          <button
            type="button"
            class="provider-credentials-close"
            aria-label="Provider認証設定を閉じる"
            onClick={onClose}
          >
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      </div>
      {state.providers.length === 0 && state.phase === "ready" ? (
        <p class="provider-credentials-empty">利用可能なProviderがありません。</p>
      ) : (
        <ul class="provider-credentials-list">
          {state.providers.map((provider) => {
            const pending = state.pendingProviderId === provider.providerId;
            return (
              <li key={provider.providerId} class="provider-credential-item">
                <div class="provider-credential-info">
                  <strong>{provider.displayName}</strong>
                  <span
                    class={`provider-credential-status provider-credential-status-${provider.status}`}
                  >
                    {getCredentialStatusLabel(provider.status)}
                  </span>
                </div>
                <div class="provider-credential-actions">
                  <button
                    type="button"
                    class="composer-toolbar-button"
                    disabled={
                      isBusy || !provider.canEdit || pending || provider.status === "unavailable"
                    }
                    onClick={() => onSet(provider.providerId)}
                  >
                    {provider.status === "configured" ? "更新" : "設定"}
                  </button>
                  {provider.status === "configured" ? (
                    <button
                      type="button"
                      class="composer-toolbar-button provider-credential-delete"
                      disabled={isBusy || !provider.canEdit || pending}
                      onClick={() => onDelete(provider.providerId)}
                    >
                      削除
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {state.phase === "loading" ? (
        <p class="provider-credentials-status-message">読み込み中...</p>
      ) : null}
      {state.noticeMessage ? (
        <p class="provider-credentials-notice" aria-live="polite">
          {state.noticeMessage}
        </p>
      ) : null}
      {state.errorMessage ? (
        <p class="provider-credentials-error" role="alert">
          {state.errorMessage}
        </p>
      ) : null}
    </section>
  );
}
