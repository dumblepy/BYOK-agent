import { vi, describe, expect, it } from "vitest";

const mocks = vi.hoisted(() => ({
  registration: {
    dispose: vi.fn(),
  },
  registerWebviewViewProvider: vi.fn(),
}));
mocks.registerWebviewViewProvider.mockReturnValue(mocks.registration);

vi.mock("vscode", () => ({
  window: {
    registerWebviewViewProvider: mocks.registerWebviewViewProvider,
  },
}));

import { activate, deactivate } from "../../src/extension/extension";

describe("Extension Host lifecycle", () => {
  it("activates through the ApplicationServices composition root and releases UI registration", async () => {
    const context = {
      secrets: {},
      globalStorageUri: {},
    } as never;

    await activate(context);
    await deactivate();
    await deactivate();

    expect(mocks.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.registration.dispose).toHaveBeenCalledTimes(1);
  });
});
