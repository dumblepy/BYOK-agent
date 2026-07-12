import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import {
  getPermissionProfileDescription,
  getPermissionProfileLabel,
  type PermissionSelectorState,
} from "../permission-profile-state";
import type { UserSelectablePermissionProfile } from "../../../permissions/permission-profile";

const profiles: readonly UserSelectablePermissionProfile[] = [
  "read-only",
  "confirm-writes",
  "workspace-write",
];

export interface PermissionProfileSelectorProps {
  readonly state: PermissionSelectorState;
  readonly disabled?: boolean;
  readonly onSelect: (profile: UserSelectablePermissionProfile) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function PermissionProfileSelector({
  state,
  disabled = false,
  onSelect,
  onConfirm,
  onCancel,
}: PermissionProfileSelectorProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isBusy = state.phase === "loading" || state.phase === "updating";
  const isDisabled = disabled || isBusy || state.summary === undefined;
  const summary = state.summary;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

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
        buttonRef.current?.focus();
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
    if (!isDisabled && state.phase !== "confirming") {
      setIsOpen((open) => !open);
    }
  };

  const handleSelect = (profile: UserSelectablePermissionProfile): void => {
    if (profile === summary?.requestedProfile || isDisabled) {
      return;
    }
    setIsOpen(false);
    onSelect(profile);
  };

  const currentLabel = summary
    ? getPermissionProfileLabel(summary.requestedProfile)
    : "権限状態を読み込み中";

  return (
    <div class="permission-selector" aria-label="権限プロファイル選択">
      <button
        ref={buttonRef}
        type="button"
        class="composer-toolbar-button composer-toolbar-mode-button permission-selector-button"
        disabled={isDisabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-describedby="permission-selector-status permission-selector-error"
        onClick={handleToggle}
      >
        <i class="codicon codicon-shield" aria-hidden="true" />
        <span>{currentLabel}</span>
        <i class="codicon codicon-chevron-down" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div ref={menuRef} class="permission-selector-menu" role="menu">
          <p class="permission-selector-menu-title">権限プロファイル</p>
          {profiles.map((profile) => (
            <button
              key={profile}
              type="button"
              class={`permission-selector-menu-item ${profile === summary?.requestedProfile ? "permission-selector-menu-item-selected" : ""}`}
              role="menuitemradio"
              aria-checked={profile === summary?.requestedProfile}
              onClick={() => handleSelect(profile)}
            >
              <span>
                <strong>{getPermissionProfileLabel(profile)}</strong>
                <small>{getPermissionProfileDescription(profile)}</small>
              </span>
              {profile === summary?.requestedProfile ? (
                <i class="codicon codicon-check permission-selector-check" aria-label="選択中" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {state.errorMessage ? (
        <p id="permission-selector-error" class="permission-selector-error" role="alert">
          {state.errorMessage}
        </p>
      ) : null}

      {state.phase === "confirming" && state.pendingProfile ? (
        <div
          class="permission-confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby="permission-confirmation-title"
        >
          <div class="permission-confirmation-panel">
            <h2 id="permission-confirmation-title">権限を変更しますか？</h2>
            <p>
              {getPermissionProfileLabel(state.pendingProfile)}:{" "}
              {getPermissionProfileDescription(state.pendingProfile)}
            </p>
            <div class="permission-confirmation-actions">
              <button type="button" class="composer-toolbar-button" onClick={onCancel}>
                キャンセル
              </button>
              <button type="button" class="permission-confirm-button" onClick={onConfirm}>
                変更
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
