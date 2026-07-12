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
  const snapshotThreadIdRef = useRef(DEFAULT_THREAD_ID);
  const protocolClient = useMemo(
    () =>
      new WebviewProtocolClient(vscodeApi, window, {
        onMessage: (message) => {
          if (message.type === "thread-snapshot") {
            snapshotThreadIdRef.current = message.payload.threadId;
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
          } else if (message.type === "error") {
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
        onDraftChange={handleComposerDraftChange}
        onSubmit={handleComposerSubmit}
        onStop={handleComposerStop}
      />
      <p class="hint">BYOK設定は後続の設定画面で追加できます。</p>
    </main>
  );
}

const root = document.getElementById("app");

if (root !== null) {
  render(<App />, root);
}
