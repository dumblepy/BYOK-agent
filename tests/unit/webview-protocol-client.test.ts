import { describe, expect, it, vi } from "vitest";

import {
  WebviewProtocolClient,
  type WebviewProtocolApi,
  type WebviewMessageWindow,
} from "../../src/ui/webview-protocol-client";
import { createExtensionToUiMessage } from "../../src/ui/webview-protocol";

class FakeWindow implements WebviewMessageWindow {
  private listener: ((event: MessageEvent<unknown>) => void) | undefined;

  public addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listener = listener;
  }

  public removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.listener === listener) {
      this.listener = undefined;
    }
  }

  public emit(data: unknown): void {
    this.listener?.({ data } as MessageEvent<unknown>);
  }
}

describe("WebviewProtocolClient", () => {
  it("sends ui-ready and typed UI actions", () => {
    const api: WebviewProtocolApi = { postMessage: vi.fn() };
    const messageWindow = new FakeWindow();
    const client = new WebviewProtocolClient(api, messageWindow);

    client.start();
    const messageId = client.send("send-message", { threadId: "thread-1", text: "hello" });

    expect(api.postMessage).toHaveBeenCalledTimes(2);
    expect((api.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      type: "ui-ready",
      protocolVersion: "1.0",
    });
    expect((api.postMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      type: "send-message",
      payload: { threadId: "thread-1", text: "hello" },
      messageId,
    });
    client.dispose();
  });

  it("delivers validated messages, ignores duplicates, and requests a snapshot on a gap", () => {
    const api: WebviewProtocolApi = { postMessage: vi.fn() };
    const messageWindow = new FakeWindow();
    const onMessage = vi.fn();
    const onSequenceGap = vi.fn();
    const client = new WebviewProtocolClient(api, messageWindow, { onMessage, onSequenceGap });

    client.start();
    const firstEvent = createExtensionToUiMessage("thread-event", {
      threadId: "thread-1",
      sequence: 1,
      event: { kind: "assistant-text", text: "first" },
    });
    const duplicateEvent = { ...firstEvent };
    const gapEvent = createExtensionToUiMessage("thread-event", {
      threadId: "thread-1",
      sequence: 3,
      event: { kind: "assistant-text", text: "third" },
    });

    messageWindow.emit(firstEvent);
    messageWindow.emit(duplicateEvent);
    messageWindow.emit(gapEvent);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onSequenceGap).toHaveBeenCalledWith(gapEvent);
    client.dispose();
  });

  it("drops malformed Host messages before the reducer callback", () => {
    const api: WebviewProtocolApi = { postMessage: vi.fn() };
    const messageWindow = new FakeWindow();
    const onMessage = vi.fn();
    const client = new WebviewProtocolClient(api, messageWindow, { onMessage });

    client.start();
    messageWindow.emit({
      protocolVersion: "1.0",
      messageId: "not-a-uuid",
      sentAt: Date.now(),
      type: "permission-updated",
      payload: { profile: "read-only" },
    });

    expect(onMessage).not.toHaveBeenCalled();
    client.dispose();
  });

  it("does not compare thread metadata revisions with event sequences", () => {
    const api: WebviewProtocolApi = { postMessage: vi.fn() };
    const messageWindow = new FakeWindow();
    const onMessage = vi.fn();
    const client = new WebviewProtocolClient(api, messageWindow, { onMessage });

    client.start();
    messageWindow.emit(
      createExtensionToUiMessage("thread-snapshot", {
        threadId: "thread-1",
        revision: 5,
        eventSequence: 0,
        events: [],
      }),
    );
    messageWindow.emit(
      createExtensionToUiMessage("thread-event", {
        threadId: "thread-1",
        sequence: 1,
        event: { kind: "user-message", text: "送信済み" },
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1]?.[0]).toMatchObject({ type: "thread-event" });
    client.dispose();
  });
});
