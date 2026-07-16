import { describe, expect, it } from "vitest";

import { prepareToolResult } from "../../src/context/tool-result-artifact";
import { FileArtifactStore } from "../../src/storage/artifact-store";

describe("artifact persistence agent simulation", () => {
  it("keeps a large command result out of the conversation body", async () => {
    const store = new FileArtifactStore({ maxArtifactBytes: 100_000 });
    const result = await prepareToolResult(
      {
        threadId: "simulation-thread",
        kind: "command-output",
        output: `\u001b[31mapi_key=secret-value\u001b[0m\n${"passing\n".repeat(2_000)}`,
        inlineLimitChars: 100,
      },
      store,
    );

    expect(result.artifactRef?.uri).toMatch(/^artifact:\/\/simulation-thread\//);
    expect(result.text.length).toBeLessThan(2_000);
    expect(result.text).not.toContain("secret-value");
    expect(
      new TextDecoder().decode((await store.read(result.artifactRef!.uri)).bytes),
    ).not.toContain("secret-value");
    expect(result.text).toContain(result.artifactRef!.uri);
  });

  it("does not persist binary output unless explicitly allowed", async () => {
    const store = new FileArtifactStore();
    const result = await prepareToolResult(
      {
        threadId: "simulation-thread",
        kind: "tool-result",
        output: new Uint8Array([0, 1, 2, 3]),
        inlineLimitChars: 1,
      },
      store,
    );

    expect(result.artifactRef).toBeUndefined();
    expect(result.binary).toBe(true);
  });
});
