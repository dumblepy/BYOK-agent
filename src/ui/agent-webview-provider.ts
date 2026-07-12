import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { AgentRunRequest } from "../agent/agent-service";
import { type ModelCatalog } from "../models/model-catalog";
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
  type UiToExtensionMessage,
} from "./webview-protocol";

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
    "font-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

export interface AgentWebviewProviderOptions {
  readonly modelCatalog?: ModelCatalog;
  readonly threadModelStore?: ThreadModelStore;
  readonly isThreadRunActive?: (threadId: string) => boolean;
  readonly isWorkspaceTrusted?: () => boolean;
  readonly onDidGrantWorkspaceTrust?: (listener: () => void) => vscode.Disposable;
  readonly prepareAgentRunRequest?: (
    request: AgentRunRequest,
  ) => Promise<AgentRunRequest> | AgentRunRequest;
}

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly threadModelStore: ThreadModelStore | undefined;
  private readonly isThreadRunActive: (threadId: string) => boolean;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly onDidGrantWorkspaceTrust:
    ((listener: () => void) => vscode.Disposable) | undefined;
  private readonly prepareAgentRunRequest:
    ((request: AgentRunRequest) => Promise<AgentRunRequest> | AgentRunRequest) | undefined;
  private activeThreadId: string | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    options: AgentWebviewProviderOptions = {},
  ) {
    this.modelCatalog = options.modelCatalog;
    this.threadModelStore = options.threadModelStore;
    this.isThreadRunActive = options.isThreadRunActive ?? (() => false);
    this.isWorkspaceTrusted = options.isWorkspaceTrusted ?? (() => true);
    this.onDidGrantWorkspaceTrust = options.onDidGrantWorkspaceTrust;
    this.prepareAgentRunRequest = options.prepareAgentRunRequest;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, ...WEBVIEW_ROOT);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, webviewRoot);

    const protocolSession = new ExtensionWebviewProtocolSession(webviewView.webview, {
      getModelList: (threadId) => this.getModelList(threadId),
      getPermissionSummary: (threadId) => this.getPermissionSummary(threadId),
      onMessage: async (message) => {
        await this.handleUiMessage(message, protocolSession);
      },
    });
    const trustSubscription = this.onDidGrantWorkspaceTrust?.(() => {
      void protocolSession.sendPermissionUpdated(this.activeThreadId ?? DEFAULT_THREAD_ID);
    });
    webviewView.onDidDispose?.(() => {
      trustSubscription?.dispose();
      protocolSession.dispose();
    });
  }

  private async handleUiMessage(
    message: UiToExtensionMessage,
    protocolSession: ExtensionWebviewProtocolSession,
  ): Promise<void> {
    if (message.type === "select-model") {
      await this.handleSelectModel(message, protocolSession);
      return;
    }

    if (message.type === "set-permission") {
      await this.handleSetPermission(message, protocolSession);
      return;
    }

    if (message.type !== "send-message") {
      // Agent execution and cancellation are connected by the Agent Runtime task.
      return;
    }

    const text = message.payload.text.replace(/\r\n?/g, "\n");
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
        await this.prepareAgentRunRequest?.({
          threadId: message.payload.threadId,
          text,
          modelId: modelState.selectedModelId,
          permissionContext: permissionSummary,
        });
      } catch {
        await this.sendModelError(
          protocolSession,
          "TOOL_EXECUTION_FAILED",
          "モデルへのリクエストを準備できませんでした。再試行してください。",
          message.messageId,
        );
        return;
      }
    }

    await protocolSession.sendThreadEvent(
      message.payload.threadId,
      {
        kind: "user-message",
        messageId: message.messageId,
        text,
      },
      message.messageId,
    );
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
    const models = (this.modelCatalog?.listAvailable() ?? []).map(({ id, label, provider }) => ({
      id,
      label,
      provider,
    }));
    const state = this.threadModelStore
      ? await this.threadModelStore.getThreadModelState(threadId)
      : { threadId, revision: 0 };
    let resolvedState = state;

    if (this.threadModelStore && models.length > 0 && state.modelId === undefined) {
      resolvedState = await this.threadModelStore.updateThreadModel(
        threadId,
        state.revision,
        models[0].id,
      );
    }

    const selectedModelId =
      resolvedState.modelId && models.some((model) => model.id === resolvedState.modelId)
        ? resolvedState.modelId
        : undefined;
    return {
      threadId,
      threadRevision: resolvedState.revision,
      models,
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

  private async sendModelError(
    protocolSession: ExtensionWebviewProtocolSession,
    code:
      | "MODEL_NOT_FOUND"
      | "MODEL_SELECTION_CONFLICT"
      | "MODEL_SELECTION_BUSY"
      | "MODEL_NOT_SELECTED"
      | "TOOL_EXECUTION_FAILED",
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
    <title>BYOK Agent</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${escapeHtmlAttribute(nonce)}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
