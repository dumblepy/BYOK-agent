import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { AgentRunRequest } from "../agent/agent-service";
import { type ModelCatalog } from "../models/model-catalog";
import type { ProviderService } from "../providers/provider-service";
import type { StorageService } from "../storage/storage-service";
import { createPermissionSummary, type PermissionSummary } from "../permissions/permission-profile";
import {
  ThreadPermissionRevisionConflictError,
  ThreadModelRevisionConflictError,
  type ThreadModelStore,
} from "../storage/thread-model-store";
import { ExtensionWebviewProtocolSession } from "./extension-webview-protocol";
import {
  createExtensionToUiMessage,
  DEFAULT_THREAD_ID,
  type AgentErrorCode,
  type ThreadEvent,
  type UiToExtensionMessage,
} from "./webview-protocol";
import type { ModelCatalogChangeSubscription } from "../models/model-catalog";
import type { DiagnosticLogger } from "../observability/diagnostic-logger";

const WEBVIEW_ROOT = ["out", "webview"] as const;

function escapeHtmlAttribute(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

function createContentSecurityPolicy(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

export interface AgentWebviewProviderOptions {
  readonly modelCatalog?: ModelCatalog;
  readonly providerService?: ProviderService;
  readonly threadModelStore?: ThreadModelStore;
  readonly storage?: StorageService;
  readonly isThreadRunActive?: (threadId: string) => boolean;
  readonly isWorkspaceTrusted?: () => boolean;
  readonly onDidGrantWorkspaceTrust?: (listener: () => void) => vscode.Disposable;
  readonly prepareAgentRunRequest?: (
    request: AgentRunRequest,
  ) => Promise<AgentRunRequest> | AgentRunRequest;
  readonly logger?: DiagnosticLogger;
}

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly providerService: ProviderService | undefined;
  private readonly threadModelStore: ThreadModelStore | undefined;
  private readonly storage: StorageService | undefined;
  private readonly isThreadRunActive: (threadId: string) => boolean;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly onDidGrantWorkspaceTrust:
    ((listener: () => void) => vscode.Disposable) | undefined;
  private readonly prepareAgentRunRequest:
    ((request: AgentRunRequest) => Promise<AgentRunRequest> | AgentRunRequest) | undefined;
  private activeThreadId: string | undefined;
  private readonly logger: DiagnosticLogger | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    options: AgentWebviewProviderOptions = {},
  ) {
    this.modelCatalog = options.modelCatalog;
    this.providerService = options.providerService;
    this.threadModelStore = options.threadModelStore;
    this.storage = options.storage;
    this.isThreadRunActive = options.isThreadRunActive ?? (() => false);
    this.isWorkspaceTrusted = options.isWorkspaceTrusted ?? (() => true);
    this.onDidGrantWorkspaceTrust = options.onDidGrantWorkspaceTrust;
    this.prepareAgentRunRequest = options.prepareAgentRunRequest;
    this.logger = options.logger;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, ...WEBVIEW_ROOT);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, webviewRoot);

    const protocolSession = new ExtensionWebviewProtocolSession(webviewView.webview, {
      logger: this.logger,
      getModelList: (threadId) => this.getModelList(threadId),
      getPermissionSummary: (threadId) => this.getPermissionSummary(threadId),
      getProviderCredentials: (providerId) => this.getProviderCredentials(providerId),
      getThreadList: () => this.getThreadList(),
      getThreadSnapshot: (threadId) => this.getThreadSnapshot(threadId),
      onMessage: async (message) => {
        await this.handleUiMessage(message, protocolSession);
      },
    });
    let modelCatalogSubscription: ModelCatalogChangeSubscription | undefined;
    if (this.modelCatalog?.onDidChange) {
      modelCatalogSubscription = this.modelCatalog.onDidChange(() => {
        const threadId = this.activeThreadId;
        if (threadId !== undefined) void protocolSession.sendModelList(threadId);
        void protocolSession.sendProviderCredentials();
      });
    }
    const trustSubscription = this.onDidGrantWorkspaceTrust?.(() => {
      void protocolSession.sendPermissionUpdated(this.activeThreadId ?? DEFAULT_THREAD_ID);
    });
    webviewView.onDidDispose?.(() => {
      trustSubscription?.dispose();
      modelCatalogSubscription?.dispose();
      protocolSession.dispose();
    });
  }

  private async handleUiMessage(
    message: UiToExtensionMessage,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    this.logger?.debug("ui.message.received", {
      type: message.type,
      messageId: message.messageId,
    });
    if (message.type === "select-model") {
      await this.handleSelectModel(message, protocolSession);
      return;
    }

    if (message.type === "set-permission") {
      await this.handleSetPermission(message, protocolSession);
      return;
    }

    if (message.type === "request-provider-credentials") {
      await protocolSession.sendProviderCredentials(message.payload.providerId, message.messageId);
      return;
    }

    if (message.type === "set-provider-credential") {
      await this.handleSetProviderCredential(message, protocolSession);
      return;
    }

    if (message.type === "delete-provider-credential") {
      await this.handleDeleteProviderCredential(message, protocolSession);
      return;
    }

    if (message.type === "rename-thread") {
      await this.handleRenameThread(message, protocolSession);
      return;
    }

    if (message.type !== "send-message") {
      // Agent execution and cancellation are connected by the Agent Runtime task.
      return;
    }

    const text = message.payload.text.replace(/\r\n?/g, "\n");
    this.logger?.info("agent.message.accepted-by-host", {
      threadId: message.payload.threadId,
      messageId: message.messageId,
      textLength: text.length,
    });
    if (text.trim().length === 0) {
      await protocolSession.sendToUi(
        createExtensionToUiMessage(
          "error",
          {
            code: "PROVIDER_BAD_REQUEST",
            message: "メッセージを入力してください。",
            retryable: true,
          },
          { correlationId: message.messageId },
        ),
      );
      return;
    }

    if (this.modelCatalog && this.threadModelStore) {
      const modelState = await this.getModelList(message.payload.threadId);
      this.logger?.debug("agent.model-state.loaded", {
        threadId: message.payload.threadId,
        selectedModelId: modelState.selectedModelId,
        modelCount: modelState.models.length,
      });
      if (modelState.selectedModelId === undefined) {
        await this.sendModelError(
          protocolSession,
          "MODEL_NOT_SELECTED",
          "モデルを選択してから送信してください。",
          message.messageId,
        );
        return;
      }

      try {
        const permissionSummary = await this.getPermissionSummary(message.payload.threadId);
        this.logger?.debug("agent.run-prepare.started", {
          threadId: message.payload.threadId,
          modelId: modelState.selectedModelId,
          permissionProfile: permissionSummary.effectiveProfile,
        });
        await this.prepareAgentRunRequest?.({
          threadId: message.payload.threadId,
          text,
          modelId: modelState.selectedModelId,
          permissionContext: permissionSummary,
        });
        this.logger?.info("agent.run-prepare.completed", {
          threadId: message.payload.threadId,
          modelId: modelState.selectedModelId,
        });
      } catch (error) {
        this.logger?.error("agent.run-prepare.failed", {
          threadId: message.payload.threadId,
          modelId: modelState.selectedModelId,
          errorName: error instanceof Error ? error.name : "unknown",
        });
        await this.sendModelError(
          protocolSession,
          "TOOL_EXECUTION_FAILED",
          "モデルへのリクエストを準備できませんでした。再試行してください。",
          message.messageId,
        );
        return;
      }
    }

    if (this.storage) {
      try {
        await this.storage.getThreadModelState(message.payload.threadId);
        await this.storage.appendUserMessage(message.payload.threadId, {
          eventId: message.messageId,
          runId: message.messageId,
          kind: "user-message",
          payload: { messageId: message.messageId, text },
        });
      } catch {
        await protocolSession.sendToUi(
          createExtensionToUiMessage(
            "error",
            {
              code: "TOOL_EXECUTION_FAILED",
              message: "メッセージを保存できませんでした。再試行してください。",
              retryable: true,
            },
            { correlationId: message.messageId },
          ),
        );
        return;
      }
    }

    this.logger?.debug("ui.thread-event.sending", {
      threadId: message.payload.threadId,
      messageId: message.messageId,
      eventKind: "user-message",
    });
    await protocolSession.sendThreadEvent(
      message.payload.threadId,
      {
        kind: "user-message",
        messageId: message.messageId,
        text,
      },
      message.messageId,
    );
    await protocolSession.sendThreadList();
    this.logger?.info("ui.thread-event.sent", {
      threadId: message.payload.threadId,
      messageId: message.messageId,
      eventKind: "user-message",
    });
  }

  private async handleRenameThread(
    message: Extract<UiToExtensionMessage, { type: "rename-thread" }>,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    if (!this.storage) {
      await this.sendModelError(
        protocolSession,
        "THREAD_NOT_FOUND",
        "スレッドを変更できません。",
        message.messageId,
      );
      return;
    }

    try {
      await this.storage.rename(
        message.payload.threadId,
        message.payload.expectedThreadRevision,
        message.payload.title,
      );
      await protocolSession.sendThreadList(message.messageId);
      if (this.activeThreadId === message.payload.threadId) {
        await protocolSession.sendThreadSnapshotForSelection(
          message.payload.threadId,
          message.messageId,
        );
      }
    } catch (error) {
      const conflict = error instanceof Error && error.name === "ThreadRevisionConflictError";
      await this.sendModelError(
        protocolSession,
        conflict ? "THREAD_RENAME_CONFLICT" : "THREAD_TITLE_INVALID",
        conflict
          ? "スレッドが更新されています。最新のタイトルを確認してください。"
          : "タイトルを保存できませんでした。",
        message.messageId,
      );
      await protocolSession.sendThreadList(message.messageId);
    }
  }

  private async getThreadList() {
    if (!this.storage) return [];
    await this.storage.getThreadModelState(DEFAULT_THREAD_ID);
    const threads = await this.storage.list();
    return threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      revision: thread.revision,
      updatedAt: thread.updatedAt,
      archived: thread.archived,
    }));
  }

  private async getThreadSnapshot(threadId: string) {
    if (!this.storage) return { revision: 0, events: [] as readonly ThreadEvent[] };
    const state = await this.storage.getThreadModelState(threadId);
    const result = await this.storage.read(threadId);
    const events: ThreadEvent[] = result.events.flatMap((event): ThreadEvent[] => {
      if (event.kind !== "user-message" && event.kind !== "assistant-text") return [];
      const payload = event.payload as {
        readonly messageId?: unknown;
        readonly text?: unknown;
      };
      if (typeof payload.text !== "string") return [];
      return event.kind === "user-message"
        ? [
            {
              kind: "user-message" as const,
              ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
              text: payload.text,
            },
          ]
        : [
            {
              kind: "assistant-text" as const,
              ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
              text: payload.text,
            },
          ];
    });
    return { revision: state.revision, events };
  }

  private async handleSelectModel(
    message: Extract<UiToExtensionMessage, { type: "select-model" }>,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    if (!this.modelCatalog || !this.threadModelStore) {
      await this.sendModelError(
        protocolSession,
        "MODEL_NOT_FOUND",
        "利用可能なモデルを取得できません。",
        message.messageId,
      );
      return;
    }

    if (this.activeThreadId !== undefined && this.activeThreadId !== message.payload.threadId) {
      await this.sendModelError(
        protocolSession,
        "MODEL_SELECTION_CONFLICT",
        "現在表示しているスレッドが変更されています。再表示して再試行してください。",
        message.messageId,
      );
      return;
    }

    if (this.isThreadRunActive(message.payload.threadId)) {
      await this.sendModelError(
        protocolSession,
        "MODEL_SELECTION_BUSY",
        "実行中はモデルを変更できません。処理の完了後に再試行してください。",
        message.messageId,
      );
      return;
    }

    if (!this.modelCatalog.findAvailable(message.payload.modelId)) {
      await this.sendModelError(
        protocolSession,
        "MODEL_NOT_FOUND",
        "選択したモデルは利用できません。モデル一覧を更新してください。",
        message.messageId,
      );
      return;
    }

    try {
      await this.threadModelStore.updateThreadModel(
        message.payload.threadId,
        message.payload.expectedThreadRevision,
        message.payload.modelId,
      );
      await protocolSession.sendModelList(message.payload.threadId, message.messageId);
    } catch (error) {
      if (error instanceof ThreadModelRevisionConflictError) {
        await this.sendModelError(
          protocolSession,
          "MODEL_SELECTION_CONFLICT",
          "モデル一覧が更新されています。最新の状態を確認してください。",
          message.messageId,
        );
        await protocolSession.sendModelList(message.payload.threadId, message.messageId);
        return;
      }

      await this.sendModelError(
        protocolSession,
        "TOOL_EXECUTION_FAILED",
        "モデルの変更を保存できませんでした。再試行してください。",
        message.messageId,
      );
    }
  }

  private async handleSetPermission(
    message: Extract<UiToExtensionMessage, { type: "set-permission" }>,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    if (!this.threadModelStore) {
      await this.sendPermissionError(
        protocolSession,
        "PERMISSION_PROFILE_NOT_ALLOWED",
        "権限状態を保存できません。",
        message.messageId,
      );
      return;
    }

    if (this.activeThreadId !== undefined && this.activeThreadId !== message.payload.threadId) {
      await this.sendPermissionError(
        protocolSession,
        "PERMISSION_SELECTION_CONFLICT",
        "現在表示しているスレッドが変更されています。再表示して再試行してください。",
        message.messageId,
      );
      return;
    }

    if (this.isThreadRunActive(message.payload.threadId)) {
      await this.sendPermissionError(
        protocolSession,
        "PERMISSION_SELECTION_BUSY",
        "実行中は権限を変更できません。処理の完了後に再試行してください。",
        message.messageId,
      );
      return;
    }

    try {
      await this.threadModelStore.updateThreadPermission(
        message.payload.threadId,
        message.payload.expectedThreadRevision,
        message.payload.profile,
      );
      await protocolSession.sendPermissionUpdated(message.payload.threadId, message.messageId);
    } catch (error) {
      if (error instanceof ThreadPermissionRevisionConflictError) {
        await this.sendPermissionError(
          protocolSession,
          "PERMISSION_SELECTION_CONFLICT",
          "権限状態が更新されています。最新の状態を確認してください。",
          message.messageId,
        );
        await protocolSession.sendPermissionUpdated(message.payload.threadId, message.messageId);
        return;
      }

      await this.sendPermissionError(
        protocolSession,
        "TOOL_EXECUTION_FAILED",
        "権限の変更を保存できませんでした。再試行してください。",
        message.messageId,
      );
    }
  }

  private async getModelList(threadId: string) {
    this.activeThreadId = threadId;
    const models = (this.modelCatalog?.listAvailable() ?? []).map(
      ({ id, label, provider, effectiveCapabilities }) => ({
        id,
        label,
        provider: provider.id,
        capabilities: {
          toolCalling: effectiveCapabilities.toolCalling,
          streaming: effectiveCapabilities.streaming,
          vision: effectiveCapabilities.vision,
          reasoning: effectiveCapabilities.reasoning,
          reasoningEfforts: [...effectiveCapabilities.reasoningEfforts],
        },
      }),
    );
    const state = this.threadModelStore
      ? await this.threadModelStore.getThreadModelState(threadId)
      : { threadId, revision: 0 };
    let resolvedState = state;

    if (this.threadModelStore && models.length > 0 && state.modelId === undefined) {
      const defaultModel = this.modelCatalog?.getDefault();
      if (!defaultModel) {
        return {
          threadId,
          threadRevision: state.revision,
          models,
          ...(this.modelCatalog && this.modelCatalog.diagnostics().length > 0
            ? {
                diagnostics: this.modelCatalog.diagnostics().map((diagnostic) => ({
                  path: diagnostic.path,
                  code: diagnostic.code,
                  severity: diagnostic.severity,
                  message: diagnostic.userMessage,
                })),
              }
            : {}),
        };
      }
      try {
        resolvedState = await this.threadModelStore.updateThreadModel(
          threadId,
          state.revision,
          defaultModel.id,
        );
      } catch {
        // A storage failure must not hide an otherwise valid model list from the UI.
        // The explicit selection can be retried after the storage problem is resolved.
        resolvedState = state;
      }
    }

    const selectedModelId =
      resolvedState.modelId && models.some((model) => model.id === resolvedState.modelId)
        ? resolvedState.modelId
        : undefined;
    return {
      threadId,
      threadRevision: resolvedState.revision,
      models,
      ...(this.modelCatalog && this.modelCatalog.diagnostics().length > 0
        ? {
            diagnostics: this.modelCatalog.diagnostics().map((diagnostic) => ({
              path: diagnostic.path,
              code: diagnostic.code,
              severity: diagnostic.severity,
              message: diagnostic.userMessage,
            })),
          }
        : {}),
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  }

  private async getPermissionSummary(threadId: string): Promise<PermissionSummary> {
    const state = this.threadModelStore
      ? await this.threadModelStore.getThreadPermissionState(threadId)
      : {
          threadId,
          permissionProfile: "confirm-writes" as const,
          revision: 0,
        };
    return createPermissionSummary(
      threadId,
      state.permissionProfile,
      state.revision,
      this.isWorkspaceTrusted() ? "trusted" : "restricted",
    );
  }

  private getProviderEntries(): readonly { id: string; label: string; vendor: string }[] {
    const entries = new Map<string, { id: string; label: string; vendor: string }>();
    for (const model of this.modelCatalog?.listAvailable() ?? []) {
      if (!entries.has(model.provider.id)) {
        entries.set(model.provider.id, {
          id: model.provider.id,
          label: model.provider.id,
          vendor: model.provider.vendor,
        });
      }
    }
    return [...entries.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label, "ja") || left.id.localeCompare(right.id),
    );
  }

  private async getProviderCredentials(providerId?: string) {
    const entries = this.getProviderEntries().filter(
      (entry) => providerId === undefined || entry.id === providerId,
    );
    return Promise.all(
      entries.map(async (entry) => ({
        providerId: entry.id,
        displayName: entry.label,
        vendor: entry.vendor,
        status: (await this.providerService?.getApiKeyStatus(entry.id)) ?? "not-configured",
        canEdit: this.providerService !== undefined,
      })),
    );
  }

  private findProvider(providerId: string): { id: string; label: string } | undefined {
    return this.getProviderEntries().find((provider) => provider.id === providerId);
  }

  private async handleSetProviderCredential(
    message: Extract<UiToExtensionMessage, { type: "set-provider-credential" }>,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    const provider = this.findProvider(message.payload.providerId);
    let status: "succeeded" | "cancelled" | "failed" = "failed";
    if (provider && this.providerService) {
      const value = await vscode.window.showInputBox({
        prompt: `${provider.label} のAPIキーを入力してください`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) =>
          input.trim().length > 0 ? undefined : "APIキーを入力してください。",
      });
      if (value === undefined) {
        status = "cancelled";
      } else {
        try {
          await this.providerService.setApiKey(provider.id, value);
          status = "succeeded";
        } catch {
          status = "failed";
        }
      }
    }
    await protocolSession.sendToUi(
      createExtensionToUiMessage(
        "provider-credential-operation",
        { providerId: message.payload.providerId, operation: "set", status },
        { correlationId: message.messageId },
      ),
    );
    await protocolSession.sendProviderCredentials(message.payload.providerId, message.messageId);
  }

  private async handleDeleteProviderCredential(
    message: Extract<UiToExtensionMessage, { type: "delete-provider-credential" }>,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    const provider = this.findProvider(message.payload.providerId);
    let status: "succeeded" | "cancelled" | "failed" = "failed";
    if (provider && this.providerService) {
      const confirmation = await vscode.window.showWarningMessage(
        `${provider.label} のAPIキーを削除しますか？`,
        { modal: true },
        "削除",
      );
      if (confirmation === "削除") {
        try {
          await this.providerService.deleteApiKey(provider.id);
          status = "succeeded";
        } catch {
          status = "failed";
        }
      } else {
        status = "cancelled";
      }
    }
    await protocolSession.sendToUi(
      createExtensionToUiMessage(
        "provider-credential-operation",
        { providerId: message.payload.providerId, operation: "delete", status },
        { correlationId: message.messageId },
      ),
    );
    await protocolSession.sendProviderCredentials(message.payload.providerId, message.messageId);
  }

  private async sendModelError(
    protocolSession: ExtensionWebviewProtocolSession,
    code: AgentErrorCode,
    message: string,
    correlationId: string,
  ): Promise<void> {
    await protocolSession.sendToUi(
      createExtensionToUiMessage("error", { code, message, retryable: true }, { correlationId }),
    );
  }

  private async sendPermissionError(
    protocolSession: ExtensionWebviewProtocolSession,
    code:
      | "PERMISSION_SELECTION_CONFLICT"
      | "PERMISSION_SELECTION_BUSY"
      | "PERMISSION_PROFILE_NOT_ALLOWED"
      | "WORKSPACE_NOT_TRUSTED"
      | "TOOL_EXECUTION_FAILED",
    message: string,
    correlationId: string,
  ): Promise<void> {
    await protocolSession.sendToUi(
      createExtensionToUiMessage("error", { code, message, retryable: true }, { correlationId }),
    );
  }

  private getHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
    const nonce = randomBytes(16).toString("hex");
    const scriptUri = escapeHtmlAttribute(
      webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.js")).toString(),
    );
    const styleUri = escapeHtmlAttribute(
      webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.css")).toString(),
    );
    const codiconStyleUri = escapeHtmlAttribute(
      webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "codicon.css")).toString(),
    );
    const contentSecurityPolicy = escapeHtmlAttribute(createContentSecurityPolicy(webview, nonce));

    return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="${contentSecurityPolicy};"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${codiconStyleUri}" />
    <title>BYOK Agent</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${escapeHtmlAttribute(nonce)}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
