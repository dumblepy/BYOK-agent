import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileEventStore } from "../../src/storage/event-store";

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
});
