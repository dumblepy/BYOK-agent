import * as vscode from "vscode";

import type { ExtensionContext } from "vscode";

import { AgentWebviewProvider } from "../ui/agent-webview-provider";

const AGENT_VIEW_ID = "byokAgent.view";

/**
 * VS Code Extension Host entry point.
 *
 * Register the Activity Bar view and its Webview provider.
 */
export function activate(context: ExtensionContext): void {
  const provider = new AgentWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: false,
      },
    }),
  );
}

/**
 * Extension Host teardown hook reserved for future service cleanup.
 */
export function deactivate(): void {
  // The initial extension does not retain resources.
}
