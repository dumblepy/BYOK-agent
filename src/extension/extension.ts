import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import { join } from "node:path";

import { createApplicationServices, type ApplicationServices } from "./application-services";
import {
  defaultUserCommonPath,
  ModelConfigLoader,
  type ModelConfigDiagnostic,
} from "../models/model-config-loader";

let applicationServices: ApplicationServices | undefined;
let activationPromise: Promise<void> | undefined;
let modelConfigLoader: ModelConfigLoader | undefined;
let modelConfigOutput: vscode.OutputChannel | undefined;

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
    .then(() => createApplicationServices(context))
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
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspaceConfigPath = workspacePath
    ? join(workspacePath, ".vscode", "byok-agent.models.json")
    : undefined;
  modelConfigLoader = new ModelConfigLoader({
    userCommonPath: defaultUserCommonPath(),
    workspacePath: workspaceConfigPath,
    workspaceTrusted: vscode.workspace.isTrusted,
    userSettings: () => vscode.workspace.getConfiguration("byokAgent").get("models"),
    onDidChange: (snapshot) => {
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
  if (!snapshot) modelConfigOutput.appendLine("[models] 有効なモデル設定を読み込めませんでした。");
  modelConfigLoader.watch();
  context.subscriptions?.push(modelConfigLoader, modelConfigOutput);
}

function appendModelConfigDiagnostic(diagnostic: ModelConfigDiagnostic): void {
  modelConfigOutput?.appendLine(
    `[models] 読み込みエラー: source=${diagnostic.source}, path=${diagnostic.path ?? "-"}, codes=${diagnostic.issues.map((issue) => issue.code).join(",")}`,
  );
}
