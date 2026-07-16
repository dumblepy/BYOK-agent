import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArtifactStoreError,
  FileArtifactStore,
  type ArtifactMetadata,
} from "../../src/storage/artifact-store";

describe("FileArtifactStore", () => {
  it("publishes an artifact atomically and restores it after recreation", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-artifacts-"));
    const first = new FileArtifactStore({ rootPath, chunkBytes: 4, maxArtifactBytes: 32 });
    const content = new TextEncoder().encode("abcdefghij");
    const ref = await first.create({
      threadId: "thread-1",
      kind: "command-output",
      mediaType: "text/plain",
      encoding: "utf-8",
      content,
      createdAt: 1,
    });

    expect(ref.uri).toMatch(/^artifact:\/\/thread-1\/[0-9a-f-]{36}$/);
    expect(
      await readFile(
        join(rootPath, "threads", "thread-1", "artifacts", ref.artifactId, "meta.json"),
        "utf8",
      ),
    ).not.toContain("abcdefghij");
    const restored = new FileArtifactStore({ rootPath, chunkBytes: 4, maxArtifactBytes: 32 });
    const result = await restored.read(ref.uri, { offset: 2, limit: 4 });
    expect(new TextDecoder().decode(result.bytes)).toBe("cdef");
    expect(result.complete).toBe(false);
    expect((await restored.stat(ref.uri))?.contentHash).toBe(ref.contentHash);
  });

  it("rejects unsafe references and refuses partial artifacts over the individual limit", async () => {
    const store = new FileArtifactStore({
      maxArtifactBytes: 4,
      maxThreadBytes: 8,
      maxTotalBytes: 8,
    });
    await expect(
      store.create({
        threadId: "thread-1",
        kind: "tool-result",
        mediaType: "text/plain",
        encoding: "utf-8",
        content: new TextEncoder().encode("12345"),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_QUOTA_EXCEEDED" });
    await expect(store.read("artifact://thread-1/../escape")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("evicts the oldest unleased artifact while preserving a leased one", async () => {
    const store = new FileArtifactStore({
      maxArtifactBytes: 4,
      maxThreadBytes: 8,
      maxTotalBytes: 8,
      now: () => 10,
    });
    const first = await store.create({
      threadId: "thread-1",
      kind: "tool-result",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new Uint8Array([1, 2, 3, 4]),
      createdAt: 1,
    });
    const lease = await store.acquireLease(first.uri);
    const second = await store.create({
      threadId: "thread-1",
      kind: "tool-result",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new Uint8Array([5, 6, 7, 8]),
      createdAt: 2,
    });

    await expect(store.stat(first.uri)).resolves.toBeDefined();
    await expect(store.stat(second.uri)).resolves.toBeDefined();
    lease.release();
    const third = await store.create({
      threadId: "thread-1",
      kind: "tool-result",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new Uint8Array([9, 10, 11, 12]),
      createdAt: 3,
    });
    await expect(store.stat(first.uri)).resolves.toBeUndefined();
    await expect(store.stat(third.uri)).resolves.toBeDefined();
  });

  it("expires artifacts without extending retention on read", async () => {
    let now = 1_000;
    const store = new FileArtifactStore({
      retentionDays: 1,
      now: () => now,
      maxArtifactBytes: 100,
      maxThreadBytes: 100,
      maxTotalBytes: 100,
    });
    const ref = await store.create({
      threadId: "thread-1",
      kind: "diagnostic",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new Uint8Array([1]),
      createdAt: 1,
    });
    await store.read(ref.uri);
    now = 86_402_000;
    await store.sweep();
    await expect(store.stat(ref.uri)).resolves.toBeUndefined();
  });

  it("does not expose corrupted metadata as a valid artifact", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-artifacts-"));
    const store = new FileArtifactStore({ rootPath });
    const ref = await store.create({
      threadId: "thread-1",
      kind: "tool-result",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new Uint8Array([1, 2]),
    });
    const metadataPath = join(
      rootPath,
      "threads",
      "thread-1",
      "artifacts",
      ref.artifactId,
      "meta.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactMetadata;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(metadataPath, JSON.stringify({ ...metadata, byteLength: 999 }), "utf8"),
    );
    await expect(store.read(ref.uri)).rejects.toBeInstanceOf(ArtifactStoreError);
  });
});
