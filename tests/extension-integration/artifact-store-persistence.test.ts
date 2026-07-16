import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileArtifactStore } from "../../src/storage/artifact-store";

describe("Artifact Store persistence integration", () => {
  it("restores only the owning thread's artifact after the storage boundary is recreated", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "byok-agent-artifact-integration-"));
    const first = new FileArtifactStore({ rootPath });
    const ref = await first.create({
      threadId: "integration-thread",
      kind: "command-output",
      mediaType: "text/plain",
      encoding: "utf-8",
      content: new TextEncoder().encode("full command output"),
    });

    const recreated = new FileArtifactStore({ rootPath });
    await expect(recreated.read(ref.uri)).resolves.toMatchObject({
      metadata: { threadId: "integration-thread", byteLength: 19 },
    });
    await expect(
      recreated.stat("artifact://other-thread/" + ref.artifactId),
    ).resolves.toBeUndefined();
  });
});
