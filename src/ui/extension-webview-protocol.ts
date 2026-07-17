import {
  createExtensionToUiMessage,
  getMessageId,
  isWithinMessageSize,
  parseExtensionToUiMessage,
  parseUiToExtensionMessage,
  type ExtensionToUiMessage,
  type ModelListPayload,
  type PermissionSummaryValue,
  type ProviderCredentialSummary,
  type ThreadSummary,
  type ThreadEvent,
  type UiToExtensionMessage,
} from "./webview-protocol";
import type { DiagnosticLogger } from "../observability/diagnostic-logger";

export interface WebviewMessagePort {
  postMessage(message: ExtensionToUiMessage): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
}

export interface ExtensionWebviewProtocolHandlers {
  readonly logger?: DiagnosticLogger;
  readonly onMessage?: (message: UiToExtensionMessage) => void | Promise<void>;
  readonly getModelList?: (threadId: string) => ModelListPayload | Promise<ModelListPayload>;
  readonly getPermissionSummary?: (
    threadId: string,
  ) => PermissionSummaryValue | Promise<PermissionSummaryValue>;
  readonly getProviderCredentials?: (
    providerId?: string,
  ) => readonly ProviderCredentialSummary[] | Promise<readonly ProviderCredentialSummary[]>;
  readonly getInitialThreadId?: () => string | Promise<string>;
  readonly getThreadList?: () => readonly ThreadSummary[] | Promise<readonly ThreadSummary[]>;
  readonly getThreadSnapshot?: (threadId: string) =>
    | {
        readonly revision: number;
        readonly eventSequence?: number;
        readonly events: readonly ThreadEvent[];
      }
    | Promise<{
        readonly revision: number;
        readonly eventSequence?: number;
        readonly events: readonly ThreadEvent[];
      }>;
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
    this.handlers.logger?.debug("protocol.outgoing", {
      type: validated.type,
      messageId: validated.messageId,
      correlationId: validated.correlationId,
    });
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
      this.handlers.logger?.warn("protocol.incoming.invalid", {
        valueType: typeof value,
      });
      await this.sendInvalidMessageError(value);
      return;
    }

    if (this.seenMessageIds.has(message.messageId)) {
      this.handlers.logger?.warn("protocol.incoming.duplicate", {
        type: message.type,
        messageId: message.messageId,
      });
      return;
    }
    this.rememberMessageId(message.messageId);

    if (message.type === "ui-ready") {
      await this.handleUiReady(message);
      return;
    }

    if (message.type === "request-thread-snapshot") {
      await this.sendThreadSnapshotSafely(message.payload.threadId, message.messageId);
      return;
    }

    if (message.type === "request-thread-list") {
      await this.sendThreadList(message.messageId);
      return;
    }

    if (message.type === "select-thread") {
      await this.sendThreadSnapshotSafely(message.payload.threadId, message.messageId);
      return;
    }

    try {
      this.handlers.logger?.debug("protocol.handler.started", {
        type: message.type,
        messageId: message.messageId,
      });
      await this.handlers.onMessage?.(message);
      this.handlers.logger?.debug("protocol.handler.completed", {
        type: message.type,
        messageId: message.messageId,
      });
    } catch (error) {
      this.handlers.logger?.error("protocol.handler.failed", {
        type: message.type,
        messageId: message.messageId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
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
    const initialThreadId = (await this.handlers.getInitialThreadId?.()) ?? "default";
    await this.sendThreadList(message.messageId);
    await this.sendThreadSnapshot(initialThreadId, message.messageId);
  }

  public async sendThreadList(correlationId?: string): Promise<void> {
    const threads = (await this.handlers.getThreadList?.()) ?? [];
    await this.sendToUi(
      createExtensionToUiMessage(
        "thread-list",
        { threads: [...threads] },
        correlationId ? { correlationId } : {},
      ),
    );
  }

  public sendThreadSnapshotForSelection(threadId: string, correlationId: string): Promise<void> {
    return this.sendThreadSnapshot(threadId, correlationId);
  }

  private async sendThreadSnapshotSafely(threadId: string, correlationId: string): Promise<void> {
    try {
      await this.sendThreadSnapshot(threadId, correlationId);
    } catch {
      await this.sendToUi(
        createExtensionToUiMessage(
          "error",
          {
            code: "THREAD_NOT_FOUND",
            message: "このスレッドは利用できません。最新の一覧から選択してください。",
            retryable: false,
          },
          { correlationId },
        ),
      );
      await this.sendThreadList(correlationId);
    }
  }

  private async sendThreadSnapshot(threadId: string, correlationId: string): Promise<void> {
    const currentSequence = this.threadSequences.get(threadId) ?? 0;
    this.threadSequences.set(threadId, Math.max(currentSequence, 0));
    const snapshot = (await this.handlers.getThreadSnapshot?.(threadId)) ?? {
      revision: 0,
      eventSequence: 0,
      events: [],
    };
    this.threadSequences.set(threadId, snapshot.eventSequence ?? 0);
    await this.sendToUi(
      createExtensionToUiMessage(
        "thread-snapshot",
        {
          threadId,
          revision: snapshot.revision,
          eventSequence: snapshot.eventSequence ?? 0,
          events: [...snapshot.events],
        },
        { correlationId },
      ),
    );
    await this.sendModelList(threadId, correlationId);
    await this.sendPermissionUpdated(threadId, correlationId);
    await this.sendProviderCredentials(undefined, correlationId);
  }

  public async sendModelList(threadId: string, correlationId?: string): Promise<void> {
    const payload = (await this.handlers.getModelList?.(threadId)) ?? {
      threadId,
      threadRevision: 0,
      models: [],
    };
    await this.sendToUi(
      createExtensionToUiMessage("model-list", payload, correlationId ? { correlationId } : {}),
    );
  }

  public async sendPermissionUpdated(threadId: string, correlationId?: string): Promise<void> {
    const summary = (await this.handlers.getPermissionSummary?.(threadId)) ?? {
      threadId,
      threadRevision: 0,
      requestedProfile: "confirm-writes" as const,
      effectiveProfile: "confirm-writes" as const,
      workspaceTrust: "trusted" as const,
      restrictions: [],
    };
    await this.sendToUi(
      createExtensionToUiMessage(
        "permission-updated",
        { summary: { ...summary, restrictions: [...summary.restrictions] } },
        correlationId ? { correlationId } : {},
      ),
    );
  }

  public async sendProviderCredentials(providerId?: string, correlationId?: string): Promise<void> {
    const providers = (await this.handlers.getProviderCredentials?.(providerId)) ?? [];
    await this.sendToUi(
      createExtensionToUiMessage(
        "provider-credentials",
        { providers: [...providers] },
        correlationId ? { correlationId } : {},
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
