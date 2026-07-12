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

export interface ComposerProps {
  readonly state: ComposerState;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
}

export function Composer({ state, onDraftChange, onSubmit, onStop }: ComposerProps) {
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
      <label class="composer-label" htmlFor="prompt">
        依頼
      </label>
      <textarea
        ref={textareaRef}
        id="prompt"
        class="composer-input"
        rows={4}
        maxLength={MAX_COMPOSER_DRAFT_LENGTH}
        placeholder="何を作りたいですか？"
        value={state.draft}
        disabled={isBusy}
        aria-describedby="composer-hint composer-status composer-error"
        aria-busy={isBusy}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
      />
      <div class="composer-footer">
        <p id="composer-hint" class="hint">
          Enterで送信、Shift+Enterで改行
        </p>
        <span class="composer-count" aria-label={`入力文字数 ${state.draft.length}文字`}>
          {state.draft.length.toLocaleString()} / {MAX_COMPOSER_DRAFT_LENGTH.toLocaleString()}
        </span>
      </div>
      <div class="composer-actions">
        {state.phase === "running" ? (
          <button
            type="button"
            class="composer-button composer-stop-button"
            aria-label="エージェントを停止"
            onClick={onStop}
          >
            停止
          </button>
        ) : null}
        <button
          type="button"
          class="composer-button composer-send-button"
          disabled={!canSubmit}
          aria-label="メッセージを送信"
          onClick={onSubmit}
        >
          {state.phase === "submitting" ? "送信中…" : "送信"}
        </button>
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
