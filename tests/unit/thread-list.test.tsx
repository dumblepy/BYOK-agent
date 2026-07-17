import renderToString from "preact-render-to-string";
import { h } from "preact";
import { describe, expect, it } from "vitest";

import { ThreadList } from "../../src/ui/webview/components/ThreadList";

describe("ThreadList", () => {
  it("does not show the archive button for a new empty thread", () => {
    const html = renderToString(
      h(ThreadList, {
        threads: [
          {
            id: "new-thread",
            title: "新しいスレッド",
            revision: 0,
            updatedAt: 1,
            archived: false,
            isNew: true,
          },
          {
            id: "existing-thread",
            title: "既存のスレッド",
            revision: 1,
            updatedAt: 2,
            archived: false,
            isNew: false,
          },
        ],
        selectedThreadId: "new-thread",
        open: true,
        onSelect: () => undefined,
        onRename: () => undefined,
        onArchive: () => undefined,
      }),
    );

    expect(html.match(/codicon-trash/g)).toHaveLength(1);
  });
});
