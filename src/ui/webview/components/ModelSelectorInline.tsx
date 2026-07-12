import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import { getSelectedModelLabel, type ModelSelectorState } from "../model-selector-state";

export interface ModelSelectorInlineProps {
  readonly state: ModelSelectorState;
  readonly disabled?: boolean;
  readonly onSelect: (modelId: string) => void;
}

export function ModelSelectorInline({
  state,
  disabled = false,
  onSelect,
}: ModelSelectorInlineProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isDisabled =
    disabled ||
    state.phase === "loading" ||
    state.phase === "selecting" ||
    state.models.length === 0;

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent): void => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const handleToggle = (): void => {
    if (!isDisabled) {
      setIsOpen((prev) => !prev);
    }
  };

  const handleSelect = (modelId: string): void => {
    if (modelId !== state.selectedModelId) {
      onSelect(modelId);
    }
    setIsOpen(false);
  };

  const selectedModel = state.models.find((m) => m.id === state.selectedModelId);
  const modelLabel = selectedModel ? selectedModel.label : "モデル未選択";

  return (
    <div class="model-selector-inline" aria-label="モデル選択">
      <button
        ref={buttonRef}
        type="button"
        class="model-selector-inline-button"
        disabled={isDisabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`現在のモデル: ${getSelectedModelLabel(state)}`}
        onClick={handleToggle}
      >
        <span class="model-selector-inline-label">{modelLabel}</span>
        <svg
          class={`model-selector-inline-chevron ${isOpen ? "model-selector-inline-chevron-open" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 4L5 6.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen ? (
        <div ref={menuRef} class="model-selector-inline-menu" role="menu">
          <div class="model-selector-inline-menu-section">
            <div class="model-selector-inline-menu-section-title">推論</div>
            <button
              type="button"
              class="model-selector-inline-menu-item"
              role="menuitem"
              onClick={() => handleSelect("low")}
            >
              <span>低</span>
              <span class="model-selector-inline-menu-check">✓</span>
            </button>
            <button
              type="button"
              class="model-selector-inline-menu-item"
              role="menuitem"
              onClick={() => handleSelect("medium")}
            >
              <span>中</span>
            </button>
            <button
              type="button"
              class="model-selector-inline-menu-item"
              role="menuitem"
              onClick={() => handleSelect("high")}
            >
              <span>高</span>
            </button>
            <button
              type="button"
              class="model-selector-inline-menu-item"
              role="menuitem"
              onClick={() => handleSelect("very-high")}
            >
              <span>非常に高い</span>
            </button>
          </div>

          <div class="model-selector-inline-menu-divider" />

          <div class="model-selector-inline-menu-section">
            <div class="model-selector-inline-menu-section-title">
              {selectedModel ? selectedModel.label : "モデル"}
            </div>
            <div class="model-selector-inline-menu-subtitle">モデル</div>
            {state.models.map((model) => (
              <button
                key={model.id}
                type="button"
                class={`model-selector-inline-menu-item ${model.id === state.selectedModelId ? "model-selector-inline-menu-item-selected" : ""}`}
                role="menuitem"
                onClick={() => handleSelect(model.id)}
              >
                <span>{model.label}</span>
                {model.id === state.selectedModelId ? (
                  <span class="model-selector-inline-menu-check">✓</span>
                ) : null}
              </button>
            ))}
          </div>

          <div class="model-selector-inline-menu-divider" />

          <div class="model-selector-inline-menu-section">
            <button
              type="button"
              class="model-selector-inline-menu-item model-selector-inline-menu-item-submenu"
              role="menuitem"
            >
              <span>速度</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M3.5 2.5L6.5 5L3.5 7.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
