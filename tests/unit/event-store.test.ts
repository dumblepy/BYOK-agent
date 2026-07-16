import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileEventStore,
  type PersistedAgentEvent,
  PERSISTED_AGENT_EVENT_SCHEMA_VERSION,
} from "../../src/storage/event-store";

describe("FileEventStore", () => {
  it("appends events in sequence and restores them after recreation", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-events-"));
    const first = new FileEventStore({ rootPath, snapshotInterval: 2 });
    const threadId = "thread-1";

    const firstEvent = await first.append(threadId, {
      runId: "run-1",
      kind: "user-message",
      payload: { messageId: "message-1", text: "hello", complete: true },
    });
    const rest = await first.appendBatch(threadId, [
      {
        runId: "run-1",
        kind: "assistant-text",
        payload: { messageId: "message-2", text: "world", complete: true },
      },
      {
        runId: "run-1",
        kind: "usage",
        payload: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    expect([firstEvent, ...rest].map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(
      JSON.parse(await readFile(join(rootPath, "threads", threadId, "snapshot.json"))),
    ).toMatchObject({
      threadId,
      lastSequence: 3,
      eventCount: 3,
    });

    const restored = new FileEventStore({ rootPath, snapshotInterval: 2 });
    const result = await restored.read(threadId);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.recovery.ignoredLines).toBe(0);
    expect(await restored.read(threadId, { afterSequence: 1 })).toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
  });

  it("recovers valid lines around malformed, unknown, duplicate, and out-of-order rows", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-events-"));
    const threadId = "thread-recovery";
    const makeEvent = (sequence: number, eventId = randomUUID()): PersistedAgentEvent => ({
      schemaVersion: PERSISTED_AGENT_EVENT_SCHEMA_VERSION,
      eventId,
      threadId,
      runId: "run-1",
      sequence,
      occurredAt: sequence,
      kind: "assistant-text",
      payload: { text: `event-${sequence}`, complete: true },
    });
    const duplicateId = randomUUID();
    const lines = [
      JSON.stringify(makeEvent(1, duplicateId)),
      "not-json",
      JSON.stringify({ ...makeEvent(3), kind: "future-event" }),
      JSON.stringify(makeEvent(3)),
      JSON.stringify(makeEvent(2, duplicateId)),
      JSON.stringify(makeEvent(4)),
    ];
    await mkdir(join(rootPath, "threads", threadId), { recursive: true });
    await writeFile(join(rootPath, "threads", threadId, "events.jsonl"), `${lines.join("\n")}\n`, {
      encoding: "utf8",
    });

    const diagnostics: string[] = [];
    const store = new FileEventStore({
      rootPath,
      onRecovery: (_thread, report) =>
        diagnostics.push(...report.diagnostics.map((item) => item.code)),
    });
    const result = await store.read(threadId);

    expect(result.events.map((event) => event.sequence)).toEqual([1, 3, 4]);
    expect(result.recovery.scannedLines).toBe(6);
    expect(result.recovery.ignoredLines).toBe(3);
    expect(result.recovery.diagnostics.map((item) => item.code)).toEqual([
      "invalid-json",
      "unknown-event-kind",
      "out-of-order",
      "duplicate-event-id",
      "sequence-gap",
    ]);
    expect(diagnostics).toEqual(result.recovery.diagnostics.map((item) => item.code));
  });

  it("serializes concurrent appends and redacts sensitive payload fields", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-events-"));
    const store = new FileEventStore({ rootPath });
    const threadId = "thread-concurrent";

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(threadId, {
          runId: "run-1",
          kind: "tool-result",
          payload: {
            summary: `result-${index}`,
            apiKey: "sk-secret-value",
            headers: { authorization: "Bearer secret" },
            text: "api_key=another-secret",
          },
        }),
      ),
    );

    const result = await store.read(threadId);
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const saved = await readFile(join(rootPath, "threads", threadId, "events.jsonl"), "utf8");
    expect(saved).not.toContain("sk-secret-value");
    expect(saved).not.toContain("Bearer secret");
    expect(saved).not.toContain("another-secret");
    expect(saved).toContain("[redacted]");
  });

  it("does not trust a corrupt snapshot", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-events-"));
    const threadId = "thread-snapshot";
    const store = new FileEventStore({ rootPath, snapshotInterval: 1 });
    await store.append(threadId, {
      runId: "run-1",
      kind: "error",
      payload: { code: "TOOL_EXECUTION_FAILED", message: "failed" },
    });
    await writeFile(join(rootPath, "threads", threadId, "snapshot.json"), "{broken", "utf8");

    expect(await store.getSnapshot(threadId)).toBeUndefined();
    expect((await store.read(threadId)).events).toHaveLength(1);
  });
});
