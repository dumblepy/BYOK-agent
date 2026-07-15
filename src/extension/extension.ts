import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import { createApplicationServices, type ApplicationServices } from "./application-services";
import {
  defaultUserCommonPath,
  ModelConfigLoader,
  type ModelConfigDiagnostic,
} from "../models/model-config-loader";
import { ConfiguredModelCatalog } from "../models/model-catalog";

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
    .then(() => createApplicationServices(context, undefined, modelCatalog))
    .then((services) => {
      applicationServices = services;
    });

  return activationPromise.finally(() => {
    if (!applicationServices) {
      activationPromise = undefined;
    }
  });
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
