import { render } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";

import "./styles.css";
import { Composer } from "./webview/components/Composer";
import { ThreadList } from "./webview/components/ThreadList";
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
  INITIAL_PROVIDER_CREDENTIAL_STATE,
  providerCredentialReducer,
} from "./webview/provider-credential-state";
import {
  INITIAL_THREAD_VIEW_STATE,
  eventToThreadViewAction,
  threadViewReducer,
} from "./webview/thread-view-model";
import { DEFAULT_THREAD_ID, type ThreadSummary } from "./webview-protocol";
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
  const [providerCredentialState, dispatchProviderCredential] = useReducer(
    providerCredentialReducer,
    INITIAL_PROVIDER_CREDENTIAL_STATE,
  );
  const [threadList, setThreadList] = useState<readonly ThreadSummary[]>([]);
  const [isThreadListOpen, setIsThreadListOpen] = useState(false);
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
              eventSequence: message.payload.eventSequence,
              events: message.payload.events,
            });
          } else if (message.type === "thread-list") {
            setThreadList(message.payload.threads);
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
              diagnostics: message.payload.diagnostics,
              ...(message.payload.selectedModelId
                ? { selectedModelId: message.payload.selectedModelId }
                : {}),
            });
          } else if (message.type === "permission-updated") {
            dispatchPermissionSelector({
              type: "permission-updated",
              summary: message.payload.summary,
            });
          } else if (message.type === "provider-credentials") {
            dispatchProviderCredential({
              type: "credentials-updated",
              providers: message.payload.providers,
            });
          } else if (message.type === "provider-credential-operation") {
            dispatchProviderCredential({
              type: "operation-result",
              providerId: message.payload.providerId,
              status: message.payload.status,
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

  const handleThreadSelect = (threadId: string): void => {
    if (threadId === snapshotThreadIdRef.current) return;
    setIsThreadListOpen(false);
    try {
      protocolClient.send("select-thread", { threadId });
    } catch {
      dispatchComposer({
        type: "error",
        message: "スレッドを切り替えられませんでした。",
      });
    }
  };

  const handleThreadRename = (threadId: string, title: string, revision: number): void => {
    try {
      protocolClient.send("rename-thread", {
        threadId,
        title,
        expectedThreadRevision: revision,
      });
    } catch {
      dispatchComposer({
        type: "error",
        message: "タイトル変更要求を送信できませんでした。",
      });
    }
  };

  const handleNewThread = (): void => {
    setIsThreadListOpen(false);
    try {
      protocolClient.send("create-thread", {});
    } catch {
      dispatchComposer({
        type: "error",
        message: "新しいスレッドを作成できませんでした。",
      });
    }
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

  const handleSetProviderCredential = (providerId: string): void => {
    try {
      protocolClient.send("set-provider-credential", { providerId });
      dispatchProviderCredential({ type: "operation-requested", providerId });
    } catch {
      dispatchProviderCredential({ type: "error", message: "設定要求を送信できませんでした。" });
    }
  };

  const handleDeleteProviderCredential = (providerId: string): void => {
    try {
      protocolClient.send("delete-provider-credential", { providerId });
      dispatchProviderCredential({ type: "operation-requested", providerId });
    } catch {
      dispatchProviderCredential({ type: "error", message: "削除要求を送信できませんでした。" });
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
        <span class="agent-header-spacer" aria-hidden="true" />
        <nav class="agent-header-actions" aria-label="スレッド操作">
          <button
            type="button"
            class={`agent-header-button ${isThreadListOpen ? "is-active" : ""}`}
            aria-label="スレッド履歴を表示"
            aria-expanded={isThreadListOpen}
            onClick={() => setIsThreadListOpen((open) => !open)}
          >
            <i class="codicon codicon-history" aria-hidden="true" />
          </button>
          <button type="button" class="agent-header-button" aria-label="設定">
            <i class="codicon codicon-settings-gear" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="agent-header-button"
            aria-label="新しいスレッド"
            onClick={handleNewThread}
          >
            <i class="codicon codicon-edit" aria-hidden="true" />
          </button>
        </nav>
      </header>

      <ThreadList
        threads={threadList}
        selectedThreadId={snapshotThreadIdRef.current}
        open={isThreadListOpen}
        onSelect={handleThreadSelect}
        onRename={handleThreadRename}
      />

      <ThreadView messages={threadState.messages} isRestoring={!threadState.isHydrated} />

      <Composer
        state={composerState}
        modelSelectorState={modelSelectorState}
        permissionSelectorState={permissionSelectorState}
        providerCredentialState={providerCredentialState}
        onDraftChange={handleComposerDraftChange}
        onSubmit={handleComposerSubmit}
        onStop={handleComposerStop}
        onModelSelect={handleModelSelect}
        onPermissionSelect={handlePermissionSelect}
        onPermissionConfirm={handlePermissionConfirm}
        onPermissionCancel={() => dispatchPermissionSelector({ type: "confirmation-cancelled" })}
        onProviderCredentialSet={handleSetProviderCredential}
        onProviderCredentialDelete={handleDeleteProviderCredential}
      />
    </main>
  );
}

const root = document.getElementById("app");

if (root !== null) {
  render(<App />, root);
}
