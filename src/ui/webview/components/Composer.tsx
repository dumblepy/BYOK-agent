import { useEffect, useRef } from "preact/hooks";
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
import { ModelSelectorInline } from "./ModelSelectorInline";

export interface ComposerProps {
  readonly state: ComposerState;
  readonly modelSelectorState: ModelSelectorState;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onModelSelect: (modelId: string) => void;
}

export function Composer({
  state,
  modelSelectorState,
  onDraftChange,
  onSubmit,
  onStop,
  onModelSelect,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = isComposerBusy(state.phase);
  const canSubmit = !isBusy && isComposerDraftSubmittable(state.draft);
  const statusLabel = getComposerStatusLabel(state);

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
      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <button
            type="button"
            class="composer-toolbar-button"
            aria-label="添付ファイルを追加"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            class="composer-toolbar-button composer-toolbar-mode-button"
            aria-label="アクセスモードを選択"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 4V7L9 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span>フルアクセス</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
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
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3M8 3L4 7M8 3L12 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
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
