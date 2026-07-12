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

  it("parses a validated assistant streaming delta", () => {
    const message = createExtensionToUiMessage("thread-event", {
      threadId: "thread-1",
      sequence: 2,
      event: {
        kind: "assistant-text-delta",
        messageId: "assistant-1",
        delta: "続き",
        done: true,
      },
    });

    expect(parseExtensionToUiMessage(message)).toEqual(message);
  });

  it("requires a thread revision for model selection and publishes a thread model list", () => {
    const selection = createUiToExtensionMessage("select-model", {
      threadId: "thread-1",
      modelId: "coding-primary",
      expectedThreadRevision: 2,
    });
    const modelList = createExtensionToUiMessage("model-list", {
      threadId: "thread-1",
      threadRevision: 3,
      models: [{ id: "coding-primary", label: "Coding Primary", provider: "primary" }],
      selectedModelId: "coding-primary",
    });

    expect(parseUiToExtensionMessage(selection)).toEqual(selection);
    expect(parseExtensionToUiMessage(modelList)).toEqual(modelList);
    expect(
      parseUiToExtensionMessage({
        ...selection,
        payload: { ...selection.payload, expectedThreadRevision: -1 },
      }),
    ).toBeUndefined();
  });

  it("requires a thread revision and a safe summary for permission changes", () => {
    const selection = createUiToExtensionMessage("set-permission", {
      threadId: "thread-1",
      profile: "workspace-write",
      expectedThreadRevision: 2,
    });
    const update = createExtensionToUiMessage("permission-updated", {
      summary: {
        threadId: "thread-1",
        threadRevision: 3,
        requestedProfile: "workspace-write",
        effectiveProfile: "workspace-write",
        workspaceTrust: "restricted",
        restrictions: ["commands-disabled", "automatic-writes-disabled"],
      },
    });

    expect(parseUiToExtensionMessage(selection)).toEqual(selection);
    expect(parseExtensionToUiMessage(update)).toEqual(update);
    expect(
      parseUiToExtensionMessage({
        ...selection,
        payload: { ...selection.payload, profile: "autonomous" },
      }),
    ).toBeUndefined();
    expect(
      parseExtensionToUiMessage({
        ...update,
        payload: {
          summary: { ...update.payload.summary, restrictions: ["unknown"] },
        },
      }),
    ).toBeUndefined();
  });
});
