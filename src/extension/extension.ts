import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import { createApplicationServices, type ApplicationServices } from "./application-services";
import {
  defaultUserCommonPath,
  ModelConfigLoader,
  type ModelConfigDiagnostic,
} from "../models/model-config-loader";
import { ConfiguredModelCatalog } from "../models/model-catalog";
import type { ProviderService } from "../providers/provider-service";
import { OutputChannelDiagnosticLogger } from "../observability/diagnostic-logger";

let applicationServices: ApplicationServices | undefined;
let activationPromise: Promise<void> | undefined;
let modelConfigLoader: ModelConfigLoader | undefined;
let modelConfigOutput: vscode.OutputChannel | undefined;
const modelCatalog = new ConfiguredModelCatalog();

/**
 * VS Code Extension Host entry point.
 *
 * Register the Activity Bar view and its Webview provider.
 */
export function activate(context: ExtensionContext): Promise<void> {
  if (applicationServices) {
    return Promise.resolve();
  }

  if (activationPromise) {
    return activationPromise;
  }

  activationPromise = initializeModelConfig(context)
    .then(() =>
      createApplicationServices(
        context,
        undefined,
        modelCatalog,
        modelConfigOutput ? new OutputChannelDiagnosticLogger(modelConfigOutput) : undefined,
      ),
    )
    .then((services) => {
      applicationServices = services;
      registerApiKeyCommands(context, services.provider, modelCatalog);
    });

  return activationPromise.finally(() => {
    if (!applicationServices) {
      activationPromise = undefined;
    }
  });
}

function registerApiKeyCommands(
  context: ExtensionContext,
  providerService: ProviderService,
  catalog: ConfiguredModelCatalog,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("byokAgent.manageProviderCredentials", async () => {
      const selectedProvider = await selectProvider(catalog, undefined);
      if (!selectedProvider) return;
      const configured = await providerService.getApiKeyStatus(selectedProvider.id);
      const action = await vscode.window.showQuickPick(
        configured === "configured"
          ? [
              { label: "APIキーを更新", command: "set" as const },
              { label: "APIキーを削除", command: "delete" as const },
            ]
          : [{ label: "APIキーを設定", command: "set" as const }],
        { placeHolder: `${selectedProvider.label}の認証情報を管理` },
      );
      if (!action) return;
      await vscode.commands.executeCommand(
        action.command === "set" ? "byokAgent.setApiKey" : "byokAgent.deleteApiKey",
        selectedProvider.id,
      );
    }),
    vscode.commands.registerCommand("byokAgent.setApiKey", async (providerId?: unknown) => {
      const selectedProvider = await selectProvider(catalog, providerId);
      if (!selectedProvider) return;

      const value = await vscode.window.showInputBox({
        prompt: `${selectedProvider.label} のAPIキーを入力してください`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) =>
          input.trim().length > 0 ? undefined : "APIキーを入力してください。",
      });
      if (value === undefined) return;

      try {
        await providerService.setApiKey(selectedProvider.id, value);
        void vscode.window.showInformationMessage(
          `${selectedProvider.label} のAPIキーを保存しました。`,
        );
      } catch {
        void vscode.window.showErrorMessage("APIキーを保存できませんでした。");
      }
    }),
    vscode.commands.registerCommand("byokAgent.deleteApiKey", async (providerId?: unknown) => {
      const selectedProvider = await selectProvider(catalog, providerId);
      if (!selectedProvider) return;

      try {
        await providerService.deleteApiKey(selectedProvider.id);
        void vscode.window.showInformationMessage(
          `${selectedProvider.label} のAPIキーを削除しました。`,
        );
      } catch {
        void vscode.window.showErrorMessage("APIキーを削除できませんでした。");
      }
    }),
  );
}

async function selectProvider(
  catalog: ConfiguredModelCatalog,
  requestedProviderId: unknown,
): Promise<{ readonly id: string; readonly label: string } | undefined> {
  const providers = new Map<string, { readonly id: string; readonly label: string }>();
  for (const model of catalog.listAvailable()) {
    providers.set(model.provider.id, { id: model.provider.id, label: model.provider.id });
  }

  if (typeof requestedProviderId === "string" && providers.has(requestedProviderId)) {
    return providers.get(requestedProviderId);
  }

  const items = [...providers.values()].map((provider) => ({
    label: provider.label,
    provider,
  }));
  if (items.length === 0) {
    void vscode.window.showErrorMessage("利用可能なProviderがありません。");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "APIキーを管理するProviderを選択",
    ignoreFocusOut: true,
  });
  return picked?.provider;
}

/**
 * Extension Host teardown hook reserved for future service cleanup.
 */
export async function deactivate(): Promise<void> {
  if (activationPromise && !applicationServices) {
    await activationPromise.catch(() => undefined);
  }

  const services = applicationServices;
  applicationServices = undefined;
  activationPromise = undefined;

  if (services) {
    await services.dispose();
  }
  modelConfigLoader?.dispose();
  modelConfigLoader = undefined;
  modelConfigOutput?.dispose();
  modelConfigOutput = undefined;
}

async function initializeModelConfig(context: ExtensionContext): Promise<void> {
  modelConfigOutput = vscode.window.createOutputChannel("BYOK Agent");
  modelConfigOutput.show(true);
  modelConfigLoader = new ModelConfigLoader({
    userCommonPath: defaultUserCommonPath(),
    includeBuiltinDefault: false,
    onDidChange: (snapshot) => {
      modelCatalog.replace(snapshot.config, snapshot.defaultModelId);
      modelConfigOutput?.appendLine(
        `[models] 読み込み完了: revision=${snapshot.revision}, models=${snapshot.config
          .flatMap((provider) => provider.models.map((model) => `${provider.name}/${model.id}`))
          .join(", ")}`,
      );
    },
    onDiagnostic: (diagnostic) => appendModelConfigDiagnostic(diagnostic),
  });

  const created = await modelConfigLoader.ensureUserCommonConfig();
  modelConfigOutput.appendLine(`[models] 設定ファイル: ${defaultUserCommonPath()}`);
  if (created)
    modelConfigOutput.appendLine("[models] models.json が存在しなかったため自動生成しました。");
  const snapshot = await modelConfigLoader.load();
  if (snapshot) {
    modelCatalog.replace(snapshot.config, snapshot.defaultModelId);
  }
  if (!snapshot) {
    modelConfigOutput.appendLine(
      "[models] 有効なモデル設定を読み込めませんでした。直前の診断詳細を確認してください。",
    );
  }
  modelConfigLoader.watch();
  context.subscriptions?.push(modelConfigLoader, modelConfigOutput);
}

function appendModelConfigDiagnostic(diagnostic: ModelConfigDiagnostic): void {
  modelConfigOutput?.appendLine(
    `[models] 読み込みエラー: source=${diagnostic.source}, file=${diagnostic.path ?? "-"}, issueCount=${diagnostic.issues.length}`,
  );
  diagnostic.issues.forEach((issue, index) => {
    const details = [
      `code=${issue.code}`,
      `path=${issue.path}`,
      ...(issue.keyword ? [`keyword=${issue.keyword}`] : []),
      ...(issue.expected ? [`expected=${issue.expected}`] : []),
    ];
    modelConfigOutput?.appendLine(
      `[models]  詳細${index + 1}: ${details.join(", ")} message=${issue.message}`,
    );
  });
}
