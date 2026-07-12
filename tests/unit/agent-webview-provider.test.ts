import { describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  Uri: {
    joinPath: vi.fn((base: { path: string }, ...segments: string[]) => ({
      path: [base.path, ...segments].join("/"),
      toString: () => [base.path, ...segments].join("/"),
    })),
  },
}));

vi.mock("vscode", () => vscodeMock);

import { AgentWebviewProvider } from "../../src/ui/agent-webview-provider";

function createWebviewView() {
  const webview = {
    cspSource: "vscode-webview://test",
    asWebviewUri: vi.fn((uri: { path: string }) => ({
      toString: () => `vscode-resource:${uri.path}`,
    })),
    options: undefined,
    html: "",
  };

  return {
    webview,
  };
}

describe("AgentWebviewProvider", () => {
  it("restricts Webview resources and uses a nonce-only script policy", () => {
    const provider = new AgentWebviewProvider({
      extensionUri: {
        path: "/extension",
      },
    } as never);
    const view = createWebviewView();

    provider.resolveWebviewView(view as never);

    expect(view.webview.options?.enableScripts).toBe(true);
    expect(view.webview.options?.localResourceRoots).toHaveLength(1);
    expect(view.webview.options?.localResourceRoots?.[0]).toMatchObject({
      path: "/extension/out/webview",
    });
    expect(view.webview.asWebviewUri).toHaveBeenCalledTimes(2);

    const csp = view.webview.html.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];
    const script = view.webview.html.match(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/);

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src vscode-webview://test");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("font-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*vscode-webview/);

    expect(script).not.toBeNull();
    expect(script?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(csp).toContain(`script-src 'nonce-${script?.[1]}'`);
    expect(script?.[2]).toBe("vscode-resource:/extension/out/webview/main.js");
    expect(view.webview.html).toContain('href="vscode-resource:/extension/out/webview/main.css"');
    expect(view.webview.html).not.toContain("<script>");
  });

  it("generates a fresh nonce for every HTML document", () => {
    const provider = new AgentWebviewProvider({
      extensionUri: {
        path: "/extension",
      },
    } as never);
    const firstView = createWebviewView();
    const secondView = createWebviewView();

    provider.resolveWebviewView(firstView as never);
    provider.resolveWebviewView(secondView as never);

    const firstNonce = firstView.webview.html.match(/<script nonce="([^"]+)"/)?.[1];
    const secondNonce = secondView.webview.html.match(/<script nonce="([^"]+)"/)?.[1];

    expect(firstNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(firstNonce).not.toBe(secondNonce);
  });
});
