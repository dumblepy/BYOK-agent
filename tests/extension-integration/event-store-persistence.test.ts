import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileEventStore } from "../../src/storage/event-store";
import { DefaultStorageService } from "../../src/storage/storage-service";

describe("Event Store persistence integration", () => {
  it("restores the event history after the storage service boundary is recreated", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-integration-"));
    const threadId = "integration-thread";
    const firstStore = new FileEventStore({ rootPath, snapshotInterval: 1 });

    await firstStore.append(threadId, {
      runId: "integration-run",
      kind: "error",
      payload: { code: "USER_CANCELLED", message: "実行をキャンセルしました" },
    });

    const recreatedStore = new FileEventStore({ rootPath, snapshotInterval: 1 });
    const restored = await recreatedStore.read(threadId);
    const snapshot = await recreatedStore.getSnapshot(threadId);

    expect(restored.events).toHaveLength(1);
    expect(restored.events[0]).toMatchObject({
      threadId,
      runId: "integration-run",
      sequence: 1,
      kind: "error",
    });
    expect(snapshot).toMatchObject({ threadId, lastSequence: 1, eventCount: 1 });
  });

  it("derives the first user-message title without changing later titles", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-integration-"));
    const uri = { fsPath: rootPath } as never;
    const service = new DefaultStorageService({ globalStorageUri: uri });
    await service.initialize();
    const thread = await service.create();

    await service.appendUserMessage(thread.id, {
      eventId: "00000000-0000-4000-8000-000000000001",
      runId: "run-1",
      kind: "user-message",
      payload: {
        messageId: "00000000-0000-4000-8000-000000000001",
        text: "認証設定を調査してください",
      },
    });
    const titled = await service.get(thread.id);
    expect(titled).toMatchObject({
      title: "認証設定を調査してください",
      titleSource: "provisional",
      revision: 1,
    });

    await service.appendUserMessage(thread.id, {
      eventId: "00000000-0000-4000-8000-000000000002",
      runId: "run-2",
      kind: "user-message",
      payload: {
        messageId: "00000000-0000-4000-8000-000000000002",
        text: "別の依頼",
      },
    });
    expect((await service.get(thread.id))?.title).toBe("認証設定を調査してください");
    await service.dispose();
  });
});
