import { describe, expect, it } from "vitest";

import {
  INITIAL_THREAD_VIEW_STATE,
  normalizeSnapshotEvents,
  threadViewReducer,
} from "../../src/ui/webview/thread-view-model";

describe("thread view model", () => {
  it("normalizes a multi-message snapshot while preserving order and roles", () => {
    const messages = normalizeSnapshotEvents([
      { kind: "user-message", messageId: "user-1", text: "調査してください" },
      { kind: "assistant-text", messageId: "assistant-1", text: "確認します。" },
      { kind: "user-message", messageId: "user-2", text: "続けてください" },
    ]);

    expect(messages).toMatchObject([
      { id: "user-1", role: "user", text: "調査してください", phase: "complete" },
      { id: "assistant-1", role: "assistant", text: "確認します。", phase: "complete" },
      { id: "user-2", role: "user", text: "続けてください", phase: "complete" },
    ]);
  });

  it("accumulates assistant deltas and completes the same message", () => {
    const started = threadViewReducer(INITIAL_THREAD_VIEW_STATE, {
      type: "apply-event",
      sequence: 1,
      event: {
        kind: "assistant-text",
        messageId: "assistant-1",
        text: "",
        streaming: true,
      },
    });
    const continued = threadViewReducer(started, {
      type: "apply-event",
      sequence: 2,
      event: {
        kind: "assistant-text-delta",
        messageId: "assistant-1",
        delta: "こんにちは",
        done: false,
      },
    });
    const completed = threadViewReducer(continued, {
      type: "apply-event",
      sequence: 3,
      event: {
        kind: "assistant-text-delta",
        messageId: "assistant-1",
        delta: "。",
        done: true,
      },
    });

    expect(completed.messages).toMatchObject([
      { id: "assistant-1", text: "こんにちは。", phase: "complete" },
    ]);
    expect(completed.lastSequence).toBe(3);
    expect(completed.needsSnapshot).toBe(false);
  });

  it("requests a snapshot for gaps, unknown messages, and late deltas", () => {
    const gap = threadViewReducer(INITIAL_THREAD_VIEW_STATE, {
      type: "apply-event",
      sequence: 2,
      event: { kind: "user-message", text: "欠番" },
    });
    expect(gap.needsSnapshot).toBe(true);

    const unknownMessage = threadViewReducer(
      { ...INITIAL_THREAD_VIEW_STATE, lastSequence: 1 },
      {
        type: "apply-event",
        sequence: 2,
        event: {
          kind: "assistant-text-delta",
          messageId: "missing",
          delta: "補完しない",
          done: false,
        },
      },
    );
    expect(unknownMessage.messages).toHaveLength(0);
    expect(unknownMessage.needsSnapshot).toBe(true);

    const lateDelta = threadViewReducer(
      {
        ...INITIAL_THREAD_VIEW_STATE,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "完了",
            phase: "complete",
            createdAt: 1,
          },
        ],
        lastSequence: 1,
      },
      {
        type: "apply-event",
        sequence: 2,
        event: {
          kind: "assistant-text-delta",
          messageId: "assistant-1",
          delta: "遅延",
          done: true,
        },
      },
    );
    expect(lateDelta.messages[0]?.text).toBe("完了");
    expect(lateDelta.needsSnapshot).toBe(true);
  });

  it("ignores duplicate or later events while a snapshot is pending", () => {
    const first = threadViewReducer(INITIAL_THREAD_VIEW_STATE, {
      type: "apply-event",
      sequence: 1,
      event: { kind: "user-message", text: "一度だけ" },
    });
    const duplicate = threadViewReducer(first, {
      type: "apply-event",
      sequence: 1,
      event: { kind: "user-message", text: "重複" },
    });
    expect(duplicate).toEqual(first);

    const pending = threadViewReducer(
      { ...first, needsSnapshot: true },
      {
        type: "apply-event",
        sequence: 2,
        event: { kind: "user-message", text: "再同期前は適用しない" },
      },
    );
    expect(pending).toEqual({ ...first, needsSnapshot: true });
  });

  it("replaces state with a snapshot and clears a pending resync", () => {
    const pending = threadViewReducer(
      { ...INITIAL_THREAD_VIEW_STATE, needsSnapshot: true, snapshotRequestPending: true },
      {
        type: "replace-snapshot",
        revision: 4,
        eventSequence: 0,
        events: [{ kind: "assistant-text", messageId: "assistant-1", text: "同期済み" }],
      },
    );

    expect(pending.isHydrated).toBe(true);
    expect(pending.revision).toBe(4);
    expect(pending.needsSnapshot).toBe(false);
    expect(pending.snapshotRequestPending).toBe(false);
    expect(pending.messages[0]?.text).toBe("同期済み");
  });

  it("keeps metadata revision separate from live event sequence", () => {
    const hydrated = threadViewReducer(INITIAL_THREAD_VIEW_STATE, {
      type: "replace-snapshot",
      revision: 5,
      eventSequence: 0,
      events: [],
    });
    const updated = threadViewReducer(hydrated, {
      type: "apply-event",
      sequence: 1,
      event: { kind: "user-message", messageId: "user-1", text: "即時表示" },
    });

    expect(updated.messages[0]?.text).toBe("即時表示");
    expect(updated.lastSequence).toBe(1);
    expect(updated.needsSnapshot).toBe(false);
  });
});
