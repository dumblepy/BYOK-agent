import {
  createExtensionToUiMessage,
  getMessageId,
  isWithinMessageSize,
  parseExtensionToUiMessage,
  parseUiToExtensionMessage,
  type ExtensionToUiMessage,
  type ThreadEvent,
  type UiToExtensionMessage,
} from "./webview-protocol";

export interface WebviewMessagePort {
  postMessage(message: ExtensionToUiMessage): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
}

export interface ExtensionWebviewProtocolHandlers {
  readonly onMessage?: (message: UiToExtensionMessage) => void | Promise<void>;
}

const MAX_SEEN_MESSAGE_IDS = 2_048;

/** Validates and routes all messages received by the Extension Host from one Webview. */
export class ExtensionWebviewProtocolSession {
  private readonly messageSubscription: { dispose(): void } | undefined;
  private readonly seenMessageIds = new Set<string>();
  private readonly threadSequences = new Map<string, number>();
  private activeClientInstanceId: string | undefined;
  private disposed = false;

  public constructor(
    private readonly webview: WebviewMessagePort,
    private readonly handlers: ExtensionWebviewProtocolHandlers = {},
  ) {
    this.messageSubscription =
      typeof webview.onDidReceiveMessage === "function"
        ? webview.onDidReceiveMessage((message) => {
            void this.handleIncomingMessage(message);
          })
        : undefined;
  }

  public async sendToUi(message: ExtensionToUiMessage): Promise<void> {
    if (this.disposed) {
      throw new Error("Cannot send a message after the Webview protocol session was disposed");
    }

    const validated = this.validateOutgoingMessage(message);
    const delivered = await this.webview.postMessage(validated);
    if (!delivered) {
      throw new Error("The Webview rejected the protocol message");
    }
  }

  public async sendThreadEvent(
    threadId: string,
    event: ThreadEvent,
    correlationId?: string,
  ): Promise<void> {
    const sequence = (this.threadSequences.get(threadId) ?? 0) + 1;
    this.threadSequences.set(threadId, sequence);
    await this.sendToUi(
      createExtensionToUiMessage(
        "thread-event",
        { threadId, sequence, event },
        correlationId ? { correlationId } : undefined,
      ),
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.messageSubscription?.dispose();
    this.seenMessageIds.clear();
    this.threadSequences.clear();
    this.activeClientInstanceId = undefined;
  }

  private async handleIncomingMessage(value: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }

    const message = parseUiToExtensionMessage(value);
    if (!message) {
      await this.sendInvalidMessageError(value);
      return;
    }

    if (this.seenMessageIds.has(message.messageId)) {
      return;
    }
    this.rememberMessageId(message.messageId);

    if (message.type === "ui-ready") {
      await this.handleUiReady(message);
      return;
    }

    if (message.type === "request-thread-snapshot") {
      await this.sendThreadSnapshot(message.payload.threadId, message.messageId);
      return;
    }

    try {
      await this.handlers.onMessage?.(message);
    } catch {
      await this.sendToUi(
        createExtensionToUiMessage(
          "error",
          {
            code: "TOOL_EXECUTION_FAILED",
            message: "UI操作の処理に失敗しました。",
            retryable: false,
          },
          { correlationId: message.messageId },
        ),
      );
    }
  }

  private async handleUiReady(
    message: Extract<UiToExtensionMessage, { type: "ui-ready" }>,
  ): Promise<void> {
    if (!message.payload.supportedProtocolVersions.includes("1.0")) {
      await this.sendProtocolError(
        "UNSUPPORTED_VERSION",
        "サポートされている通信プロトコルのバージョンがありません。",
        message.messageId,
      );
      return;
    }

    this.activeClientInstanceId = message.payload.clientInstanceId;
    await this.sendToUi(
      createExtensionToUiMessage(
        "host-ready",
        {
          clientInstanceId: this.activeClientInstanceId,
          protocolVersion: "1.0",
        },
        { correlationId: message.messageId },
      ),
    );
    await this.sendThreadSnapshot("default", message.messageId);
    await this.sendToUi(
      createExtensionToUiMessage(
        "model-list",
        { models: [] },
        { correlationId: message.messageId },
      ),
    );
    await this.sendToUi(
      createExtensionToUiMessage(
        "permission-updated",
        { profile: "read-only" },
        { correlationId: message.messageId },
      ),
    );
  }

  private async sendThreadSnapshot(threadId: string, correlationId: string): Promise<void> {
    const currentSequence = this.threadSequences.get(threadId) ?? 0;
    this.threadSequences.set(threadId, Math.max(currentSequence, 0));
    await this.sendToUi(
      createExtensionToUiMessage(
        "thread-snapshot",
        {
          threadId,
          revision: 0,
          events: [],
        },
        { correlationId },
      ),
    );
  }

  private async sendInvalidMessageError(value: unknown): Promise<void> {
    const code = !isWithinMessageSize(value)
      ? "MESSAGE_TOO_LARGE"
      : hasUnsupportedProtocolVersion(value)
        ? "UNSUPPORTED_VERSION"
        : "INVALID_MESSAGE";
    await this.sendProtocolError(code, "無効な通信メッセージを受信しました。", getMessageId(value));
  }

  private async sendProtocolError(
    code: "UNSUPPORTED_VERSION" | "INVALID_MESSAGE" | "MESSAGE_TOO_LARGE",
    message: string,
    rejectedMessageId?: string,
  ): Promise<void> {
    try {
      await this.sendToUi(
        createExtensionToUiMessage("protocol-error", {
          code,
          message,
          ...(rejectedMessageId ? { rejectedMessageId } : {}),
        }),
      );
    } catch {
      // The Webview may already have been disposed; there is no receiver for a second error.
    }
  }

  private validateOutgoingMessage(message: ExtensionToUiMessage): ExtensionToUiMessage {
    if (!isWithinMessageSize(message)) {
      throw new Error("The protocol message exceeds the maximum size");
    }

    const parsed = parseExtensionToUiMessage(message);
    if (!parsed) {
      throw new Error("The outgoing protocol message failed validation");
    }

    return parsed;
  }

  private rememberMessageId(messageId: string): void {
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const oldestMessageId = this.seenMessageIds.values().next().value as string | undefined;
      if (oldestMessageId) {
        this.seenMessageIds.delete(oldestMessageId);
      }
    }
  }
}

function hasUnsupportedProtocolVersion(value: unknown): boolean {
  if (!isRecord(value) || typeof value.protocolVersion !== "string") {
    return false;
  }

  return value.protocolVersion.split(".")[0] !== "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
