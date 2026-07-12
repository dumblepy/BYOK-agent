import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_BYTES,
  createExtensionToUiMessage,
  createMessageId,
  createUiToExtensionMessage,
  isWithinMessageSize,
  parseExtensionToUiMessage,
  parseUiToExtensionMessage,
} from "../../src/ui/webview-protocol";

describe("Webview protocol schemas", () => {
  it("creates and parses a typed UI-to-Host message", () => {
    const message = createUiToExtensionMessage("send-message", {
      threadId: "thread-1",
      text: "調査してください",
    });

    expect(message.protocolVersion).toBe("1.0");
    expect(message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parseUiToExtensionMessage(message)).toEqual(message);
  });

  it("rejects unknown types, malformed IDs, and unexpected fields", () => {
    expect(
      parseUiToExtensionMessage({
        protocolVersion: "1.0",
        messageId: "not-a-uuid",
        sentAt: Date.now(),
        type: "send-message",
        payload: { threadId: "thread-1", text: "hello" },
      }),
    ).toBeUndefined();

    expect(
      parseUiToExtensionMessage({
        protocolVersion: "1.0",
        messageId: createMessageId(),
        sentAt: Date.now(),
        type: "unknown",
        payload: {},
      }),
    ).toBeUndefined();

    const message = createUiToExtensionMessage("cancel-run", { runId: "run-1" });
    expect(parseUiToExtensionMessage({ ...message, unexpected: true })).toBeUndefined();
  });

  it("rejects unsupported versions and oversized messages", () => {
    const message = createUiToExtensionMessage("send-message", {
      threadId: "thread-1",
      text: "hello",
    });

    expect(parseUiToExtensionMessage({ ...message, protocolVersion: "2.0" })).toBeUndefined();

    const oversizedValue = { text: "x".repeat(MAX_MESSAGE_BYTES) };
    expect(isWithinMessageSize(oversizedValue)).toBe(false);
    expect(
      parseUiToExtensionMessage({
        ...message,
        payload: { threadId: "thread-1", text: "x".repeat(MAX_MESSAGE_BYTES) },
      }),
    ).toBeUndefined();
  });

  it("parses Host-to-UI snapshots and rejects invalid event payloads", () => {
    const message = createExtensionToUiMessage("thread-snapshot", {
      threadId: "thread-1",
      revision: 0,
      events: [{ kind: "assistant-text", text: "完了しました" }],
    });

    expect(parseExtensionToUiMessage(message)).toEqual(message);
    expect(
      parseExtensionToUiMessage({
        ...message,
        payload: {
          ...message.payload,
          events: [{ kind: "assistant-text", text: "ok", unsafe: true }],
        },
      }),
    ).toBeUndefined();
  });
});
