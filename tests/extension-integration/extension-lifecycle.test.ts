import { rm } from "node:fs/promises";
import { vi, describe, expect, it } from "vitest";

vi.mock("node:os", () => ({
  homedir: () => "/tmp/byok-extension-test-home",
}));

const mocks = vi.hoisted(() => ({
  registration: {
    dispose: vi.fn(),
  },
  commandRegistration: {
    dispose: vi.fn(),
  },
  registerWebviewViewProvider: vi.fn(),
  registerCommand: vi.fn(),
  output: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
}));
mocks.registerWebviewViewProvider.mockReturnValue(mocks.registration);
mocks.registerCommand.mockReturnValue(mocks.commandRegistration);

vi.mock("vscode", () => ({
  window: {
    registerWebviewViewProvider: mocks.registerWebviewViewProvider,
    createOutputChannel: vi.fn(() => mocks.output),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: {
    registerCommand: mocks.registerCommand,
  },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
}));

import { activate, deactivate } from "../../src/extension/extension";

describe("Extension Host lifecycle", () => {
  it("activates through the ApplicationServices composition root and releases UI registration", async () => {
    await rm("/tmp/byok-extension-test-home", { recursive: true, force: true });
    const context = {
      secrets: {},
      globalStorageUri: {},
      subscriptions: [],
    } as never;

    await activate(context);
    await deactivate();
    await deactivate();

    expect(mocks.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.registration.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("models.json が存在しなかったため自動生成しました"),
    );
    expect(mocks.output.appendLine).toHaveBeenCalledWith(expect.stringContaining("読み込み完了"));
    await rm("/tmp/byok-extension-test-home", { recursive: true, force: true });
  });
});
