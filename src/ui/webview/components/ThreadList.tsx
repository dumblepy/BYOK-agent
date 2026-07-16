import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";

import type { ThreadSummary } from "../../webview-protocol";

export interface ThreadListProps {
  readonly threads: readonly ThreadSummary[];
  readonly selectedThreadId: string;
  readonly open: boolean;
  readonly onSelect: (threadId: string) => void;
  readonly onRename: (threadId: string, title: string, revision: number) => void;
}

export function ThreadList({
  threads,
  selectedThreadId,
  open,
  onSelect,
  onRename,
}: ThreadListProps): JSX.Element {
  const selected = threads.find((thread) => thread.id === selectedThreadId);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (selected && editingId === undefined) setDraft(selected.title);
  }, [selected?.id, selected?.title, editingId]);

  const startEditing = (thread: ThreadSummary): void => {
    setEditingId(thread.id);
    setDraft(thread.title);
  };

  const submit = (thread: ThreadSummary): void => {
    const title = draft.trim();
    if (title.length === 0) return;
    onRename(thread.id, title, thread.revision);
    setEditingId(undefined);
  };

  if (!open) return <></>;

  return (
    <section class="thread-list" aria-label="スレッド一覧">
      <div class="thread-list-heading">
        <h2>スレッド</h2>
        <span>{threads.length}</span>
      </div>
      {threads.length === 0 ? (
        <p class="thread-list-empty">スレッドはありません。</p>
      ) : (
        <ul>
          {threads.map((thread) => (
            <li key={thread.id} class={thread.id === selectedThreadId ? "is-selected" : undefined}>
              <button
                type="button"
                class="thread-list-item"
                aria-current={thread.id === selectedThreadId ? "page" : undefined}
                onClick={() => onSelect(thread.id)}
              >
                <span class="thread-list-title">{thread.title}</span>
              </button>
              {thread.id === selectedThreadId && editingId === thread.id ? (
                <form
                  class="thread-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(thread);
                  }}
                >
                  <input
                    value={draft}
                    maxLength={200}
                    aria-label="スレッドタイトル"
                    onInput={(event) => setDraft(event.currentTarget.value)}
                  />
                  <button type="submit" aria-label="タイトルを保存">
                    <i class="codicon codicon-check" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="タイトル編集をキャンセル"
                    onClick={() => setEditingId(undefined)}
                  >
                    <i class="codicon codicon-close" aria-hidden="true" />
                  </button>
                </form>
              ) : thread.id === selectedThreadId ? (
                <button
                  type="button"
                  class="thread-rename-button"
                  aria-label="スレッドタイトルを編集"
                  onClick={() => startEditing(thread)}
                >
                  <i class="codicon codicon-edit" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
