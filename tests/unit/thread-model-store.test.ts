import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileThreadModelStore,
  ThreadPermissionRevisionConflictError,
  ThreadModelRevisionConflictError,
} from "../../src/storage/thread-model-store";

describe("FileThreadModelStore", () => {
  it("persists a selected model atomically and rejects stale revisions", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-thread-model-"));
    const store = new FileThreadModelStore({ rootPath });

    expect(await store.getThreadModelState("thread-1")).toEqual({
      threadId: "thread-1",
      revision: 0,
    });
    const updated = await store.updateThreadModel("thread-1", 0, "coding-primary");

    expect(updated).toEqual({
      threadId: "thread-1",
      modelId: "coding-primary",
      revision: 1,
    });
    await expect(store.updateThreadModel("thread-1", 0, "coding-fast")).rejects.toBeInstanceOf(
      ThreadModelRevisionConflictError,
    );

    const saved = JSON.parse(
      await readFile(join(rootPath, "threads", "thread-1", "meta.json"), "utf8"),
    ) as { modelId: string; revision: number };
    expect(saved).toMatchObject({ modelId: "coding-primary", revision: 1 });
  });

  it("serializes concurrent updates for one thread", async () => {
    const store = new FileThreadModelStore();
    const first = store.updateThreadModel("thread-1", 0, "coding-primary");
    const second = store.updateThreadModel("thread-1", 0, "coding-fast");

    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(
      ThreadModelRevisionConflictError,
    );
    expect(await store.getThreadModelState("thread-1")).toMatchObject({
      modelId: "coding-primary",
      revision: 1,
    });
  });

  it("shares the thread revision between model and permission metadata", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-thread-permission-"));
    const store = new FileThreadModelStore({ rootPath });

    expect(await store.getThreadPermissionState("thread-1")).toEqual({
      threadId: "thread-1",
      permissionProfile: "confirm-writes",
      revision: 0,
    });

    const updated = await store.updateThreadPermission("thread-1", 0, "workspace-write");
    expect(updated).toEqual({
      threadId: "thread-1",
      permissionProfile: "workspace-write",
      revision: 1,
    });
    await expect(store.updateThreadPermission("thread-1", 0, "read-only")).rejects.toBeInstanceOf(
      ThreadPermissionRevisionConflictError,
    );

    expect(await store.getThreadModelState("thread-1")).toMatchObject({ revision: 1 });
    const saved = JSON.parse(
      await readFile(join(rootPath, "threads", "thread-1", "meta.json"), "utf8"),
    ) as { permissionProfile: string; revision: number };
    expect(saved).toMatchObject({ permissionProfile: "workspace-write", revision: 1 });
  });
});
