import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

const WEBVIEW_ROOT = ["out", "webview"] as const;

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, ...WEBVIEW_ROOT);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, webviewRoot);
  }

  private getHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.css"));

    return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>BYOK Agent</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
