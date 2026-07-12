import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { ExtensionWebviewProtocolSession } from "./extension-webview-protocol";

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

export class AgentWebviewProvider implements vscode.WebviewViewProvider {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, ...WEBVIEW_ROOT);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, webviewRoot);

    const protocolSession = new ExtensionWebviewProtocolSession(webviewView.webview);
    webviewView.onDidDispose?.(() => protocolSession.dispose());
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
