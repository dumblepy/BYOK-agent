import { describe, expect, it, vi } from "vitest";

import {
  ExtensionWebviewProtocolSession,
  type WebviewMessagePort,
} from "../../src/ui/extension-webview-protocol";
import { createMessageId, createUiToExtensionMessage } from "../../src/ui/webview-protocol";

class FakeWebview implements WebviewMessagePort {
  public readonly sent: unknown[] = [];
  private listener: ((message: unknown) => void) | undefined;

  public postMessage(message: unknown): Thenable<boolean> {
    this.sent.push(message);
    return Promise.resolve(true);
  }

  public onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  }

  public emit(message: unknown): void {
    this.listener?.(message);
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ExtensionWebviewProtocolSession", () => {
  it("validates ui-ready and sends the initial Host state", async () => {
    const webview = new FakeWebview();
    const session = new ExtensionWebviewProtocolSession(webview);
    const ready = createUiToExtensionMessage("ui-ready", {
      clientInstanceId: createMessageId(),
      supportedProtocolVersions: ["1.0"],
    });

    webview.emit(ready);
    await flush();

    expect(webview.sent.map((message) => (message as { type: string }).type)).toEqual([
      "host-ready",
      "thread-snapshot",
      "model-list",
      "permission-updated",
    ]);
    expect((webview.sent[0] as { correlationId: string }).correlationId).toBe(ready.messageId);
    session.dispose();
  });

  it("rejects malformed messages and ignores duplicate message IDs", async () => {
    const webview = new FakeWebview();
    const session = new ExtensionWebviewProtocolSession(webview);
    const ready = createUiToExtensionMessage("ui-ready", {
      clientInstanceId: createMessageId(),
      supportedProtocolVersions: ["1.0"],
    });

    webview.emit({ ...ready, payload: { ...ready.payload, clientInstanceId: "invalid" } });
    await flush();
    expect((webview.sent[0] as { type: string }).type).toBe("protocol-error");
    expect((webview.sent[0] as { payload: { code: string } }).payload.code).toBe("INVALID_MESSAGE");

    webview.sent.length = 0;
    webview.emit(ready);
    webview.emit(ready);
    await flush();
    expect(webview.sent).toHaveLength(4);
    session.dispose();
  });

  it("dispatches validated actions and does not dispatch malformed actions", async () => {
    const webview = new FakeWebview();
    const onMessage = vi.fn();
    const session = new ExtensionWebviewProtocolSession(webview, { onMessage });
    const message = createUiToExtensionMessage("send-message", {
      threadId: "thread-1",
      text: "hello",
    });
    const secondMessage = createUiToExtensionMessage(
      "send-message",
      { threadId: "thread-1", text: "hello" },
      { messageId: createMessageId() },
    );

    webview.emit(message);
    webview.emit(secondMessage);
    webview.emit({ ...message, payload: { threadId: "thread-1", text: 42 } });
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, message);
    expect(onMessage).toHaveBeenNthCalledWith(2, secondMessage);
    session.dispose();
  });
});
