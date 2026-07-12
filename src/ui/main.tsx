import { render } from "preact";
import { useState } from "preact/hooks";

import "./styles.css";
import { WebviewProtocolClient, type WebviewProtocolApi } from "./webview-protocol-client";
import { createAgentWebviewStateStore, type WebviewStateApi } from "./webview-state";

declare function acquireVsCodeApi(): WebviewStateApi & WebviewProtocolApi;

const vscodeApi = acquireVsCodeApi();
const stateStore = createAgentWebviewStateStore(vscodeApi);
const protocolClient = new WebviewProtocolClient(vscodeApi, window, {
  onSequenceGap: (message) => {
    protocolClient.send("request-thread-snapshot", { threadId: message.payload.threadId });
  },
});
protocolClient.start();

function App() {
  const [composerDraft, setComposerDraft] = useState(stateStore.state.composerDraft);

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

      <section class="welcome-card" aria-labelledby="welcome-title">
        <div class="welcome-mark" aria-hidden="true">
          ✦
        </div>
        <h2 id="welcome-title">開発を始めましょう</h2>
        <p>ファイル、選択範囲、目的を入力すると、ここからエージェントと作業を始められます。</p>
      </section>

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
