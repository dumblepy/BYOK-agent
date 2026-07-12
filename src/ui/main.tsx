import { render } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";

import "./styles.css";
import { ThreadView } from "./webview/components/ThreadView";
import {
  INITIAL_THREAD_VIEW_STATE,
  eventToThreadViewAction,
  threadViewReducer,
} from "./webview/thread-view-model";
import { DEFAULT_THREAD_ID } from "./webview-protocol";
import { WebviewProtocolClient, type WebviewProtocolApi } from "./webview-protocol-client";
import { createAgentWebviewStateStore, type WebviewStateApi } from "./webview-state";

declare function acquireVsCodeApi(): WebviewStateApi & WebviewProtocolApi;

const vscodeApi = acquireVsCodeApi();
const stateStore = createAgentWebviewStateStore(vscodeApi);

function App() {
  const [composerDraft, setComposerDraft] = useState(stateStore.state.composerDraft);
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
    if (!threadState.needsSnapshot || threadState.snapshotRequestPending) {
      return;
    }

    protocolClient.send("request-thread-snapshot", { threadId: snapshotThreadIdRef.current });
    dispatchThread({ type: "snapshot-requested" });
  }, [protocolClient, threadState.needsSnapshot, threadState.snapshotRequestPending]);

  const handleComposerInput = (event: Event): void => {
    const composerDraft = (event.currentTarget as HTMLTextAreaElement).value;
    const nextState = stateStore.setComposerDraft(composerDraft);
    setComposerDraft(nextState.composerDraft);
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

      <label class="composer-label" htmlFor="prompt">
        依頼
        <textarea
          id="prompt"
          rows={4}
          placeholder="何を作りたいですか？"
          value={composerDraft}
          onInput={handleComposerInput}
        />
      </label>
      <button type="button" disabled>
        送信
      </button>
      <p class="hint">BYOK設定は後続の設定画面で追加できます。</p>
    </main>
  );
}

const root = document.getElementById("app");

if (root !== null) {
  render(<App />, root);
}
