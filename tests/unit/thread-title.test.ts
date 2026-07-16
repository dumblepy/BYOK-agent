import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProvisionalTitle, ThreadTitleService } from "../../src/storage/thread-title";
import { FileThreadStore } from "../../src/storage/thread-store";

describe("thread title generation", () => {
  it("creates a deterministic, bounded title and masks sensitive values", () => {
    const text = "調査してください\nBearer super-secret-token\n" + "x".repeat(100);
    const first = createProvisionalTitle(text);

    expect(first).toContain("調査してください");
    expect(first).not.toContain("super-secret-token");
    expect([...first].length).toBeLessThanOrEqual(60);
    expect(createProvisionalTitle(text)).toBe(first);
  });

  it("does not overwrite a manually renamed title", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-title-"));
    const store = new FileThreadStore({ rootPath });
    const thread = await store.create();
    await store.rename(thread.id, 0, "手動タイトル");

    const service = new ThreadTitleService(store);
    const result = await service.handleFirstUserMessage(thread.id, "最初の依頼");

    expect(result.title).toBe("手動タイトル");
    expect(result.titleSource).toBe("user");
  });

  it("uses an opted-in title port only while the provisional title is current", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-title-"));
    const store = new FileThreadStore({ rootPath });
    const thread = await store.create({ modelId: "coding-primary" });
    const generate = vi.fn(async () => "LLMで付けたタイトル");
    const service = new ThreadTitleService(store, {
      autoNaming: true,
      titleGenerationPort: { generate },
    });

    const result = await service.handleFirstUserMessage(thread.id, "最初の依頼");

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ text: "最初の依頼", modelId: "coding-primary" }),
    );
    expect(result).toMatchObject({ title: "LLMで付けたタイトル", titleSource: "llm" });
  });
});
