import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileEventStore } from "../../src/storage/event-store";

describe("Agent event persistence simulation", () => {
  it("persists a simulated run in execution order", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-simulation-"));
    const store = new FileEventStore({ rootPath, snapshotInterval: 2 });
    const threadId = "simulation-thread";

    await store.appendBatch(threadId, [
      {
        runId: "simulation-run",
        kind: "user-message",
        payload: { messageId: "user-1", text: "調査してください", complete: true },
      },
      {
        runId: "simulation-run",
        kind: "tool-call",
        payload: { toolCallId: "call-1", name: "search_text", summary: "検索を開始" },
      },
      {
        runId: "simulation-run",
        kind: "tool-result",
        payload: {
          toolCallId: "call-1",
          name: "search_text",
          status: "succeeded",
          summary: "3件見つかりました",
        },
      },
      {
        runId: "simulation-run",
        kind: "assistant-text",
        payload: { messageId: "assistant-1", text: "調査結果です", complete: true },
      },
    ]);

    const result = await new FileEventStore({ rootPath }).read(threadId);
    expect(result.events.map((event) => event.kind)).toEqual([
      "user-message",
      "tool-call",
      "tool-result",
      "assistant-text",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });
});
