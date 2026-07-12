import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import {
  getModelSelectorStatusLabel,
  getSelectedModelLabel,
  type ModelSelectorState,
} from "../model-selector-state";

export interface ModelSelectorProps {
  readonly state: ModelSelectorState;
  readonly disabled?: boolean;
  readonly onSelect: (modelId: string) => void;
}

export function ModelSelector({
  state,
  disabled = false,
  onSelect,
}: ModelSelectorProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isDisabled =
    disabled ||
    state.phase === "loading" ||
    state.phase === "selecting" ||
    state.models.length === 0;
  const statusLabel = getModelSelectorStatusLabel(state);

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

  return (
    <div class="model-selector" aria-label="モデル選択">
      <button
        ref={buttonRef}
        type="button"
        class="model-selector-button"
        disabled={isDisabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`現在のモデル: ${getSelectedModelLabel(state)}`}
        onClick={handleToggle}
      >
        <span class="model-selector-button-label">
          {selectedModel ? selectedModel.label : "モデル未選択"}
        </span>
        <i
          class={`codicon codicon-chevron-down model-selector-chevron ${isOpen ? "model-selector-chevron-open" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <div ref={menuRef} class="model-selector-menu" role="menu">
          <div class="model-selector-menu-section">
            <div class="model-selector-menu-section-title">推論</div>
            <button
              type="button"
              class="model-selector-menu-item"
              role="menuitem"
              onClick={() => handleSelect("low")}
            >
              <span>低</span>
              <i class="codicon codicon-check model-selector-menu-check" aria-label="選択中" />
            </button>
            <button
              type="button"
              class="model-selector-menu-item"
              role="menuitem"
              onClick={() => handleSelect("medium")}
            >
              <span>中</span>
            </button>
            <button
              type="button"
              class="model-selector-menu-item"
              role="menuitem"
              onClick={() => handleSelect("high")}
            >
              <span>高</span>
            </button>
            <button
              type="button"
              class="model-selector-menu-item"
              role="menuitem"
              onClick={() => handleSelect("very-high")}
            >
              <span>非常に高い</span>
            </button>
          </div>

          <div class="model-selector-menu-divider" />

          <div class="model-selector-menu-section">
            <div class="model-selector-menu-section-title">
              {selectedModel ? selectedModel.label : "モデル"}
            </div>
            <div class="model-selector-menu-subtitle">モデル</div>
            {state.models.map((model) => (
              <button
                key={model.id}
                type="button"
                class={`model-selector-menu-item ${model.id === state.selectedModelId ? "model-selector-menu-item-selected" : ""}`}
                role="menuitem"
                onClick={() => handleSelect(model.id)}
              >
                <span>{model.label}</span>
                {model.id === state.selectedModelId ? (
                  <i class="codicon codicon-check model-selector-menu-check" aria-label="選択中" />
                ) : null}
              </button>
            ))}
          </div>

          <div class="model-selector-menu-divider" />

          <div class="model-selector-menu-section">
            <button
              type="button"
              class="model-selector-menu-item model-selector-menu-item-submenu"
              role="menuitem"
            >
              <span>速度</span>
              <i
                class="codicon codicon-chevron-right model-selector-menu-item-submenu"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      ) : null}

      <p id="model-selector-status" class="model-selector-status" aria-live="polite">
        {statusLabel}
      </p>
      {state.errorMessage ? (
        <p id="model-selector-error" class="model-selector-error" role="alert">
          {state.errorMessage}
        </p>
      ) : null}
    </div>
  );
}
