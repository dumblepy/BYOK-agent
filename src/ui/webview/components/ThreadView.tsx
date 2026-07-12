import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { ThreadMessageViewModel } from "../thread-view-model";

export interface ThreadViewProps {
  readonly messages: readonly ThreadMessageViewModel[];
  readonly isRestoring?: boolean;
}

const AUTO_SCROLL_THRESHOLD_PX = 64;

export function ThreadView({ messages, isRestoring = false }: ThreadViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousContentRef = useRef("");
  const [hasUnreadContent, setHasUnreadContent] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const currentContent = getContentSignature(messages);
    const contentChanged = currentContent !== previousContentRef.current;
    previousContentRef.current = currentContent;
    if (!contentChanged) {
      return;
    }

    if (messages.length === 0 || isNearBottom(container)) {
      scrollToBottom(container);
      setHasUnreadContent(false);
    } else {
      setHasUnreadContent(true);
    }
  }, [isRestoring, messages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = (): void => {
      if (isNearBottom(container)) {
        setHasUnreadContent(false);
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const handleNewContentClick = (): void => {
    const container = containerRef.current;
    if (container) {
      scrollToBottom(container);
    }
    setHasUnreadContent(false);
  };

  return (
    <section class="thread-view" aria-label="会話">
      <div ref={containerRef} class="thread-message-list" role="log" aria-live="polite">
        {isRestoring ? (
          <p class="thread-empty-state" role="status">
            会話を読み込んでいます…
          </p>
        ) : messages.length === 0 ? (
          <p class="thread-empty-state">メッセージを送ると、ここに会話が表示されます。</p>
        ) : (
          messages.map((message) => <ThreadMessage key={message.id} message={message} />)
        )}
      </div>
      {hasUnreadContent ? (
        <button type="button" class="thread-new-content" onClick={handleNewContentClick}>
          新しい内容
        </button>
      ) : null}
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

function getContentSignature(messages: readonly ThreadMessageViewModel[]): string {
  const lastMessage = messages[messages.length - 1];
  return lastMessage
    ? `${messages.length}:${lastMessage.id}:${lastMessage.text}:${lastMessage.phase}`
    : "empty";
}

function isNearBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    AUTO_SCROLL_THRESHOLD_PX
  );
}

function scrollToBottom(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}
