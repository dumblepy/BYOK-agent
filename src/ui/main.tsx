import { render } from "preact";
import { useEffect, useMemo, useReducer, useRef } from "preact/hooks";

import "./styles.css";
import { Composer } from "./webview/components/Composer";
import {
  composerReducer,
  createInitialComposerState,
  getComposerErrorMessage,
  isComposerDraftSubmittable,
  normalizeComposerDraft,
} from "./webview/composer-state";
import {
  createInitialModelSelectorState,
  getModelSelectorErrorMessage,
  modelSelectorReducer,
} from "./webview/model-selector-state";
import {
  createInitialPermissionSelectorState,
  getPermissionErrorMessage,
  permissionSelectorReducer,
  requiresPermissionConfirmation,
} from "./webview/permission-profile-state";
import type { UserSelectablePermissionProfile } from "../permissions/permission-profile";
import { ThreadView } from "./webview/components/ThreadView";
import {
  INITIAL_THREAD_VIEW_STATE,
  eventToThreadViewAction,
  threadViewReducer,
} from "./webview/thread-view-model";
import { DEFAULT_THREAD_ID } from "./webview-protocol";
import { WebviewProtocolClient, type WebviewProtocolApi } from "./webview-protocol-client";
import {
  createAgentWebviewStateStore,
  MAX_COMPOSER_DRAFT_LENGTH,
  type WebviewStateApi,
} from "./webview-state";

declare function acquireVsCodeApi(): WebviewStateApi & WebviewProtocolApi;

const vscodeApi = acquireVsCodeApi();
const stateStore = createAgentWebviewStateStore(vscodeApi);

function App() {
  const [composerState, dispatchComposer] = useReducer(
    composerReducer,
    createInitialComposerState(stateStore.state.composerDraft),
  );
  const [threadState, dispatchThread] = useReducer(threadViewReducer, INITIAL_THREAD_VIEW_STATE);
  const [modelSelectorState, dispatchModelSelector] = useReducer(
    modelSelectorReducer,
    createInitialModelSelectorState(DEFAULT_THREAD_ID),
  );
  const [permissionSelectorState, dispatchPermissionSelector] = useReducer(
    permissionSelectorReducer,
    createInitialPermissionSelectorState(DEFAULT_THREAD_ID),
  );
  const modelSelectionRequestIdRef = useRef<string | undefined>(undefined);
  const permissionSelectionRequestIdRef = useRef<string | undefined>(undefined);
  const snapshotThreadIdRef = useRef(DEFAULT_THREAD_ID);
  const protocolClient = useMemo(
    () =>
      new WebviewProtocolClient(vscodeApi, window, {
        onMessage: (message) => {
          if (message.type === "thread-snapshot") {
            snapshotThreadIdRef.current = message.payload.threadId;
            dispatchModelSelector({
              type: "thread-changed",
              threadId: message.payload.threadId,
              threadRevision: message.payload.revision,
            });
            dispatchPermissionSelector({
              type: "thread-changed",
              threadId: message.payload.threadId,
              threadRevision: message.payload.revision,
            });
            dispatchThread({
              type: "replace-snapshot",
              revision: message.payload.revision,
              events: message.payload.events,
            });
          } else if (message.type === "thread-event") {
            snapshotThreadIdRef.current = message.payload.threadId;
            dispatchThread(
              eventToThreadViewAction(message.payload.sequence, message.payload.event),
            );
            if (
              message.payload.event.kind === "user-message" &&
              message.correlationId !== undefined
            ) {
              dispatchComposer({
                type: "message-accepted",
                messageId: message.correlationId,
              });
            }
          } else if (message.type === "run-state") {
            if (message.payload.threadId === snapshotThreadIdRef.current) {
              dispatchComposer({
                type: "run-state",
                runId: message.payload.runId,
                state: message.payload.state,
              });
            }
          } else if (message.type === "model-list") {
            dispatchModelSelector({
              type: "model-list",
              threadId: message.payload.threadId,
              threadRevision: message.payload.threadRevision,
              models: message.payload.models,
              ...(message.payload.selectedModelId
                ? { selectedModelId: message.payload.selectedModelId }
                : {}),
            });
          } else if (message.type === "permission-updated") {
            dispatchPermissionSelector({
              type: "permission-updated",
              summary: message.payload.summary,
            });
          } else if (message.type === "error") {
            if (message.correlationId === modelSelectionRequestIdRef.current) {
              dispatchModelSelector({
                type: "selection-error",
                requestId: message.correlationId,
                message: getModelSelectorErrorMessage(message.payload.code),
              });
            }
            if (message.correlationId === permissionSelectionRequestIdRef.current) {
              dispatchPermissionSelector({
                type: "selection-error",
                requestId: message.correlationId,
                message: getPermissionErrorMessage(message.payload.code),
              });
            }
            dispatchComposer({
              type: "error",
              message: getComposerErrorMessage(message.payload.code),
              correlationId: message.correlationId,
            });
          } else if (message.type === "protocol-error") {
            dispatchComposer({
              type: "error",
              message: "通信に失敗しました。Webviewを再表示して再試行してください。",
            });
          }
        },
        onSequenceGap: (message) => {
          snapshotThreadIdRef.current = message.payload.threadId;
          dispatchThread({ type: "request-snapshot" });
        },
      }),
    [],
  );

  useEffect(() => {
    protocolClient.start();
    return () => protocolClient.dispose();
  }, [protocolClient]);

  useEffect(() => {
    stateStore.setComposerDraft(composerState.draft);
  }, [composerState.draft]);

  useEffect(() => {
    if (!threadState.needsSnapshot || threadState.snapshotRequestPending) {
      return;
    }

    protocolClient.send("request-thread-snapshot", { threadId: snapshotThreadIdRef.current });
    dispatchThread({ type: "snapshot-requested" });
  }, [protocolClient, threadState.needsSnapshot, threadState.snapshotRequestPending]);

  const handleComposerDraftChange = (draft: string): void => {
    const normalizedDraft = normalizeComposerDraft(draft);
    if (normalizedDraft.length > MAX_COMPOSER_DRAFT_LENGTH) {
      dispatchComposer({
        type: "draft-rejected",
        message: `入力は${MAX_COMPOSER_DRAFT_LENGTH.toLocaleString()}文字以内にしてください。`,
      });
      return;
    }

    dispatchComposer({ type: "draft-changed", draft: normalizedDraft });
  };

  const handleComposerSubmit = (): void => {
    if (
      composerState.phase === "submitting" ||
      composerState.phase === "running" ||
      composerState.phase === "stopping" ||
      !isComposerDraftSubmittable(composerState.draft)
    ) {
      return;
    }

    if (modelSelectorState.selectedModelId === undefined) {
      dispatchModelSelector({
        type: "selection-error",
        message: "モデルを選択してから送信してください。",
      });
      return;
    }

    try {
      const messageId = protocolClient.send("send-message", {
        threadId: snapshotThreadIdRef.current,
        text: composerState.draft,
      });
      dispatchComposer({
        type: "submit-requested",
        messageId,
        text: composerState.draft,
      });
    } catch {
      dispatchComposer({
        type: "error",
        message: "メッセージを送信できませんでした。もう一度お試しください。",
      });
    }
  };

  const handleModelSelect = (modelId: string): void => {
    if (
      modelSelectorState.threadId === undefined ||
      modelSelectorState.threadRevision === undefined ||
      (modelSelectorState.phase !== "ready" && modelSelectorState.phase !== "error")
    ) {
      return;
    }

    try {
      const requestId = protocolClient.send("select-model", {
        threadId: modelSelectorState.threadId,
        modelId,
        expectedThreadRevision: modelSelectorState.threadRevision,
      });
      modelSelectionRequestIdRef.current = requestId;
      dispatchModelSelector({ type: "selection-requested", modelId, requestId });
    } catch {
      dispatchModelSelector({
        type: "selection-error",
        message: "モデルの変更要求を送信できませんでした。",
      });
    }
  };

  const handleComposerStop = (): void => {
    if (composerState.phase !== "running" || composerState.activeRunId === undefined) {
      return;
    }

    try {
      protocolClient.send("cancel-run", { runId: composerState.activeRunId });
      dispatchComposer({ type: "stop-requested" });
    } catch {
      dispatchComposer({
        type: "error",
        message: "停止要求を送信できませんでした。",
      });
    }
  };

  const sendPermissionSelection = (profile: UserSelectablePermissionProfile): void => {
    const summary = permissionSelectorState.summary;
    if (
      summary === undefined ||
      (permissionSelectorState.phase !== "ready" &&
        permissionSelectorState.phase !== "error" &&
        permissionSelectorState.phase !== "confirming")
    ) {
      return;
    }

    try {
      const requestId = protocolClient.send("set-permission", {
        threadId: summary.threadId,
        profile,
        expectedThreadRevision: summary.threadRevision,
      });
      permissionSelectionRequestIdRef.current = requestId;
      dispatchPermissionSelector({ type: "selection-requested", profile, requestId });
    } catch {
      dispatchPermissionSelector({
        type: "selection-error",
        message: "権限の変更要求を送信できませんでした。",
      });
    }
  };

  const handlePermissionSelect = (profile: UserSelectablePermissionProfile): void => {
    const current = permissionSelectorState.summary?.requestedProfile;
    if (current === undefined) {
      return;
    }

    if (requiresPermissionConfirmation(current, profile)) {
      dispatchPermissionSelector({ type: "confirmation-requested", profile });
      return;
    }

    sendPermissionSelection(profile);
  };

  const handlePermissionConfirm = (): void => {
    const profile = permissionSelectorState.pendingProfile;
    if (profile === undefined) {
      return;
    }
    sendPermissionSelection(profile);
  };

  return (
    <main class="agent-shell">
      <header class="agent-header">
        <div>
          <p class="eyebrow">BYOK CODING AGENT</p>
          <h1>Agent</h1>
        </div>
        <span class="status" aria-label="準備完了">
          Ready
        </span>
      </header>

      <ThreadView messages={threadState.messages} isRestoring={!threadState.isHydrated} />

      <Composer
        state={composerState}
        modelSelectorState={modelSelectorState}
        permissionSelectorState={permissionSelectorState}
        onDraftChange={handleComposerDraftChange}
        onSubmit={handleComposerSubmit}
        onStop={handleComposerStop}
        onModelSelect={handleModelSelect}
        onPermissionSelect={handlePermissionSelect}
        onPermissionConfirm={handlePermissionConfirm}
        onPermissionCancel={() => dispatchPermissionSelector({ type: "confirmation-cancelled" })}
      />

      <p class="hint">BYOK設定は後続の設定画面で追加できます。</p>
    </main>
  );
}

const root = document.getElementById("app");

if (root !== null) {
  render(<App />, root);
}
