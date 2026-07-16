import type { JSX } from "preact";

import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { ThreadMessageViewModel } from "../thread-view-model";

export interface ThreadViewProps {
  readonly messages: readonly ThreadMessageViewModel[];
  readonly isRestoring?: boolean;
}

export function ThreadView({ messages, isRestoring = false }: ThreadViewProps): JSX.Element {
  return (
    <section class="thread-view" aria-label="会話">
      <div class="thread-message-list" role="log" aria-live="polite">
        {isRestoring ? (
          <p class="thread-empty-state" role="status">
            会話を読み込んでいます…
          </p>
        ) : messages.length === 0 ? (
          <div class="thread-empty-state">
            <i class="codicon codicon-comment-discussion thread-empty-mark" aria-hidden="true" />
            <p class="thread-empty-state-label">メッセージを送ると、ここに会話が表示されます。</p>
          </div>
        ) : (
          messages.map((message) => <ThreadMessage key={message.id} message={message} />)
        )}
      </div>
    </section>
  );
}

export function getThreadMessageLabel(message: ThreadMessageViewModel): string {
  const role = message.role === "user" ? "ユーザー" : "エージェント";
  const state =
    message.phase === "streaming" ? "（生成中）" : message.phase === "failed" ? "（失敗）" : "";
  return `${role}のメッセージ${state}`;
}

function ThreadMessage({ message }: { readonly message: ThreadMessageViewModel }): JSX.Element {
  return (
    <article
      class={`thread-message thread-message-${message.role}`}
      aria-label={getThreadMessageLabel(message)}
      aria-busy={message.phase === "streaming" ? "true" : undefined}
    >
      <div class="thread-message-header">
        <span class="thread-message-role">
          {message.role === "user" ? "ユーザー" : "エージェント"}
        </span>
        {message.phase === "streaming" ? <span class="thread-message-status">生成中</span> : null}
      </div>
      <MarkdownRenderer source={message.text} />
      {message.phase === "failed" && message.errorMessage ? (
        <p class="thread-message-error" role="alert">
          {message.errorMessage}
        </p>
      ) : null}
    </article>
  );
}
