import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import {
  getComposerEnterAction,
  getComposerStatusLabel,
  isComposerDraftSubmittable,
  normalizeComposerDraft,
  type ComposerPhase,
  type ComposerState,
} from "../composer-state";
import { MAX_COMPOSER_DRAFT_LENGTH } from "../../webview-state";
import type { ModelSelectorState } from "../model-selector-state";
import {
  INITIAL_PERMISSION_SELECTOR_STATE,
  type PermissionSelectorState,
} from "../permission-profile-state";
import type { UserSelectablePermissionProfile } from "../../../permissions/permission-profile";
import { PermissionProfileSelector } from "./PermissionProfileSelector";
import { ModelSelectorInline } from "./ModelSelectorInline";
import { ProviderCredentialPanel } from "./ProviderCredentialPanel";
import type { ProviderCredentialState } from "../provider-credential-state";

export interface ComposerProps {
  readonly state: ComposerState;
  readonly modelSelectorState: ModelSelectorState;
  readonly permissionSelectorState?: PermissionSelectorState;
  readonly providerCredentialState?: ProviderCredentialState;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onModelSelect: (modelId: string) => void;
  readonly onPermissionSelect?: (profile: UserSelectablePermissionProfile) => void;
  readonly onPermissionConfirm?: () => void;
  readonly onPermissionCancel?: () => void;
  readonly onProviderCredentialSet?: (providerId: string) => void;
  readonly onProviderCredentialDelete?: (providerId: string) => void;
}

export function Composer({
  state,
  modelSelectorState,
  permissionSelectorState = INITIAL_PERMISSION_SELECTOR_STATE,
  providerCredentialState,
  onDraftChange,
  onSubmit,
  onStop,
  onModelSelect,
  onPermissionSelect = () => undefined,
  onPermissionConfirm = () => undefined,
  onPermissionCancel = () => undefined,
  onProviderCredentialSet = () => undefined,
  onProviderCredentialDelete = () => undefined,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = isComposerBusy(state.phase);
  const canSubmit = !isBusy && isComposerDraftSubmittable(state.draft);
  const statusLabel = getComposerStatusLabel(state);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isProviderCredentialsOpen, setIsProviderCredentialsOpen] = useState(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }

    textarea.setCustomValidity(state.errorMessage ?? "");
  }, [state.errorMessage]);

  const handleInput = (event: JSX.TargetedEvent<HTMLTextAreaElement, Event>): void => {
    onDraftChange(normalizeComposerDraft(event.currentTarget.value));
  };

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    if (getComposerEnterAction(event) !== "submit") {
      return;
    }

    event.preventDefault();
    if (canSubmit) {
      onSubmit();
    }
  };

  return (
    <section class="composer" aria-label="メッセージ入力">
      <textarea
        ref={textareaRef}
        id="prompt"
        class="composer-input"
        rows={4}
        maxLength={MAX_COMPOSER_DRAFT_LENGTH}
        placeholder="何でもできます"
        value={state.draft}
        disabled={isBusy}
        aria-describedby="composer-status composer-error"
        aria-busy={isBusy}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
      />
      {isProviderCredentialsOpen && providerCredentialState ? (
        <ProviderCredentialPanel
          state={providerCredentialState}
          onSet={onProviderCredentialSet}
          onDelete={onProviderCredentialDelete}
          onClose={() => setIsProviderCredentialsOpen(false)}
        />
      ) : null}
      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <div class="composer-menu">
            <button
              type="button"
              class="composer-toolbar-button composer-menu-toggle"
              aria-label="メニューを開く"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              <i
                class={`codicon ${isMenuOpen ? "codicon-close" : "codicon-add"}`}
                aria-hidden="true"
              />
            </button>
            {isMenuOpen ? (
              <div class="composer-menu-bar" role="menu">
                <button
                  type="button"
                  class="composer-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsProviderCredentialsOpen((open) => !open);
                    setIsMenuOpen(false);
                  }}
                >
                  <i class="codicon codicon-key" aria-hidden="true" />
                  <span>Provider認証設定</span>
                </button>
              </div>
            ) : null}
          </div>
          <PermissionProfileSelector
            state={permissionSelectorState}
            disabled={isBusy}
            onSelect={onPermissionSelect}
            onConfirm={onPermissionConfirm}
            onCancel={onPermissionCancel}
          />
        </div>
        <div class="composer-toolbar-right">
          <ModelSelectorInline
            state={modelSelectorState}
            disabled={isBusy}
            onSelect={onModelSelect}
          />
          {state.phase === "running" ? (
            <button
              type="button"
              class="composer-toolbar-button composer-stop-button"
              aria-label="エージェントを停止"
              onClick={onStop}
            >
              停止
            </button>
          ) : null}
          <button
            type="button"
            class="composer-toolbar-button composer-send-button"
            disabled={!canSubmit}
            aria-label="メッセージを送信"
            onClick={onSubmit}
          >
            <i class="codicon codicon-send" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p id="composer-status" class="composer-status" aria-live="polite">
        {statusLabel}
      </p>
      {state.errorMessage ? (
        <p id="composer-error" class="composer-error" role="alert">
          {state.errorMessage}
        </p>
      ) : null}
    </section>
  );
}

function isComposerBusy(phase: ComposerPhase): boolean {
  return phase === "submitting" || phase === "running" || phase === "stopping";
}
