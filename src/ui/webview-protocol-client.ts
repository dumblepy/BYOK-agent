import {
  createUiToExtensionMessage,
  parseExtensionToUiMessage,
  PROTOCOL_VERSION,
  createMessageId,
  type ExtensionToUiMessage,
  type UiToExtensionMessage,
  type UiToExtensionMessageType,
  type UiToExtensionPayload,
} from "./webview-protocol";

export interface WebviewProtocolApi {
  postMessage(message: UiToExtensionMessage): void;
}

export interface WebviewMessageWindow {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

export interface WebviewProtocolClientOptions {
  readonly onMessage?: (message: ExtensionToUiMessage) => void;
  readonly onSequenceGap?: (
    message: Extract<ExtensionToUiMessage, { type: "thread-event" | "run-state" }>,
  ) => void;
}

const MAX_SEEN_MESSAGE_IDS = 2_048;

/** Owns the Webview-side receive boundary and emits only validated Host messages. */
export class WebviewProtocolClient {
  private readonly clientInstanceId = createMessageId();
  private readonly seenMessageIds = new Set<string>();
  private readonly lastSequences = new Map<string, number>();
  private started = false;
  private disposed = false;

  public constructor(
    private readonly api: WebviewProtocolApi,
    private readonly messageWindow: WebviewMessageWindow,
    private readonly options: WebviewProtocolClientOptions = {},
  ) {}

  public start(): void {
    if (this.started || this.disposed) {
      return;
    }

    this.started = true;
    this.messageWindow.addEventListener("message", this.handleWindowMessage);
    this.send("ui-ready", {
      clientInstanceId: this.clientInstanceId,
      supportedProtocolVersions: [PROTOCOL_VERSION],
    });
  }

  public send<TType extends UiToExtensionMessageType>(
    type: TType,
    payload: UiToExtensionPayload<TType>,
    correlationId?: string,
  ): void {
    if (this.disposed) {
      throw new Error("Cannot send a message after the Webview protocol client was disposed");
    }

    const message = createUiToExtensionMessage(type, payload, { correlationId });
    this.api.postMessage(message);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.messageWindow.removeEventListener("message", this.handleWindowMessage);
    this.seenMessageIds.clear();
    this.lastSequences.clear();
  }

  private readonly handleWindowMessage = (event: MessageEvent<unknown>): void => {
    if (this.disposed) {
      return;
    }

    const message = parseExtensionToUiMessage(event.data);
    if (!message || this.seenMessageIds.has(message.messageId)) {
      return;
    }

    if (!this.acceptSequence(message)) {
      return;
    }

    this.rememberMessageId(message.messageId);
    this.options.onMessage?.(message);
  };

  private acceptSequence(message: ExtensionToUiMessage): boolean {
    if (message.type === "thread-snapshot") {
      this.lastSequences.set(`thread:${message.payload.threadId}`, message.payload.revision);
      return true;
    }

    if (message.type !== "thread-event" && message.type !== "run-state") {
      return true;
    }

    const key =
      message.type === "thread-event"
        ? `thread:${message.payload.threadId}`
        : `run:${message.payload.runId}`;
    const previousSequence = this.lastSequences.get(key) ?? 0;
    if (message.payload.sequence <= previousSequence) {
      return false;
    }

    if (message.payload.sequence !== previousSequence + 1) {
      this.options.onSequenceGap?.(message);
      return false;
    }

    this.lastSequences.set(key, message.payload.sequence);
    return true;
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
