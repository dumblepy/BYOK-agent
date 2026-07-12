import type { SecretStorage, Uri } from "vscode";
import { describe, expect, it } from "vitest";

import { DefaultAgentService } from "../../src/agent/agent-service";
import { DefaultProviderService } from "../../src/providers/provider-service";
import { DefaultStorageService } from "../../src/storage/storage-service";

describe("DefaultAgentService", () => {
  it("aborts active runs and waits for their completion during disposal", async () => {
    const provider = new DefaultProviderService({
      secretStorage: {} as SecretStorage,
    });
    const storage = new DefaultStorageService({
      globalStorageUri: {} as Uri,
    });
    const agent = new DefaultAgentService({ provider, storage });
    await agent.initialize();

    let completeRun: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      completeRun = resolve;
    });
    const controller = new AbortController();
    agent.registerActiveRun(controller, completion);

    const disposal = agent.dispose();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(controller.signal.aborted).toBe(true);
    completeRun?.();
    await disposal;

    await provider.dispose();
    await storage.dispose();
  });
});
