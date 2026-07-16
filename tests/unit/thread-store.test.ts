import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileThreadStore, ThreadRevisionConflictError } from "../../src/storage/thread-store";

describe("FileThreadStore", () => {
  it("creates, updates, archives, and restores threads", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-threads-"));
    const first = new FileThreadStore({ rootPath });
    const created = await first.create({
      title: "調査",
      modelId: "coding-primary",
      permissionProfile: "read-only",
    });

    const updated = await first.update(created.id, 0, { permissionProfile: "workspace-write" });
    expect(updated).toMatchObject({
      modelId: "coding-primary",
      permissionProfile: "workspace-write",
      revision: 1,
    });
    const archived = await first.archive(created.id, 1);
    expect(archived.archived).toBe(true);
    expect(await first.list()).toEqual([]);
    expect((await first.list({ includeArchived: true })).map((thread) => thread.id)).toEqual([
      created.id,
    ]);

    const restored = new FileThreadStore({ rootPath });
    expect(await restored.get(created.id)).toMatchObject({
      id: created.id,
      modelId: "coding-primary",
      revision: 2,
      archived: true,
    });
  });

  it("sorts deterministically and ignores corrupt entries", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-threads-"));
    const ignored: string[] = [];
    const store = new FileThreadStore({ rootPath, onIgnoredEntry: (path) => ignored.push(path) });
    const first = await store.create({ title: "first" });
    const second = await store.create({ title: "second" });
    await writeFile(join(rootPath, "threads", first.id, "meta.json"), "not-json");
    await mkdir(join(rootPath, "threads", "bad-id"));
    await writeFile(join(rootPath, "threads", "bad-id", "meta.json"), "{}");

    const restored = new FileThreadStore({
      rootPath,
      onIgnoredEntry: (path) => ignored.push(path),
    });
    expect((await restored.list()).map((thread) => thread.id)).toEqual([second.id]);
    expect(ignored).toHaveLength(2);
  });

  it("rejects unsafe ids, profiles, and stale updates without saving secrets", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-threads-"));
    const store = new FileThreadStore({ rootPath });
    await expect(store.get("../escape")).rejects.toThrow();
    await expect(store.create({ permissionProfile: "autonomous" as never })).rejects.toThrow();
    const thread = await store.create({ modelId: "logical-model" });
    await expect(store.update(thread.id, 0, { title: "new" })).resolves.toMatchObject({
      revision: 1,
    });
    await expect(store.update(thread.id, 0, { title: "stale" })).rejects.toBeInstanceOf(
      ThreadRevisionConflictError,
    );
    const saved = await readFile(join(rootPath, "threads", thread.id, "meta.json"), "utf8");
    expect(saved).not.toContain("Authorization");
    expect(saved).not.toContain("api_key");
  });
});
