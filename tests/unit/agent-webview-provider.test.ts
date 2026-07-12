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
import { StaticModelCatalog } from "../../src/models/model-catalog";
import { FileThreadModelStore } from "../../src/storage/thread-model-store";
import { createUiToExtensionMessage } from "../../src/ui/webview-protocol";

function createWebviewView() {
  let listener: ((message: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const webview = {
    cspSource: "vscode-webview://test",
    asWebviewUri: vi.fn((uri: { path: string }) => ({
      toString: () => `vscode-resource:${uri.path}`,
    })),
    options: undefined,
    html: "",
    postMessage: vi.fn((message: unknown) => {
      sent.push(message);
      return Promise.resolve(true);
    }),
    onDidReceiveMessage: vi.fn((nextListener: (message: unknown) => void) => {
      listener = nextListener;
      return { dispose: vi.fn() };
    }),
  };

  return {
    webview,
    sent,
    emit(message: unknown) {
      listener?.(message);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("routes a validated user message back as a correlated thread event", async () => {
    const provider = new AgentWebviewProvider({
      extensionUri: {
        path: "/extension",
      },
    } as never);
    const view = createWebviewView();
    provider.resolveWebviewView(view as never);

    const message = createUiToExtensionMessage("send-message", {
      threadId: "thread-1",
      text: "複数行\nの依頼",
    });
    view.emit(message);
    await flush();

    expect(view.sent).toContainEqual(
      expect.objectContaining({
        type: "thread-event",
        correlationId: message.messageId,
        payload: {
          threadId: "thread-1",
          sequence: 1,
          event: {
            kind: "user-message",
            messageId: message.messageId,
            text: "複数行\nの依頼",
          },
        },
      }),
    );
  });

  it("lists models, persists a thread selection, and rejects stale selections", async () => {
    const store = new FileThreadModelStore();
    const prepareAgentRunRequest = vi.fn((request) => request);
    const provider = new AgentWebviewProvider(
      {
        extensionUri: { path: "/extension" },
      } as never,
      {
        modelCatalog: new StaticModelCatalog([
          { id: "coding-primary", label: "Coding Primary", provider: "primary" },
          { id: "coding-fast", label: "Coding Fast", provider: "primary" },
        ]),
        threadModelStore: store,
        prepareAgentRunRequest,
      },
    );
    const view = createWebviewView();
    provider.resolveWebviewView(view as never);

    const ready = createUiToExtensionMessage("ui-ready", {
      clientInstanceId: "00000000-0000-4000-8000-000000000001",
      supportedProtocolVersions: ["1.0"],
    });
    view.emit(ready);
    await flush();

    const initialList = view.sent.findLast(
      (message) => (message as { type?: string }).type === "model-list",
    ) as { payload: { threadRevision: number; selectedModelId?: string } };
    expect(initialList.payload).toMatchObject({
      threadRevision: 1,
      selectedModelId: "coding-fast",
    });

    const selection = createUiToExtensionMessage("select-model", {
      threadId: "default",
      modelId: "coding-primary",
      expectedThreadRevision: initialList.payload.threadRevision,
    });
    view.emit(selection);
    await flush();

    const updatedList = view.sent.findLast(
      (message) => (message as { type?: string }).type === "model-list",
    ) as { payload: { threadRevision: number; selectedModelId?: string } };
    expect(updatedList.payload).toMatchObject({
      threadRevision: 2,
      selectedModelId: "coding-primary",
    });
    expect(await store.getThreadModelState("default")).toMatchObject({
      modelId: "coding-primary",
      revision: 2,
    });

    const nextMessage = createUiToExtensionMessage("send-message", {
      threadId: "default",
      text: "選択モデルで実行してください",
    });
    view.emit(nextMessage);
    await flush();
    expect(prepareAgentRunRequest).toHaveBeenCalledWith({
      threadId: "default",
      text: "選択モデルで実行してください",
      modelId: "coding-primary",
    });

    const staleSelection = createUiToExtensionMessage("select-model", {
      threadId: "default",
      modelId: "coding-fast",
      expectedThreadRevision: 1,
    });
    view.emit(staleSelection);
    await flush();
    expect(view.sent).toContainEqual(
      expect.objectContaining({
        type: "error",
        correlationId: staleSelection.messageId,
        payload: expect.objectContaining({ code: "MODEL_SELECTION_CONFLICT" }),
      }),
    );
  });

  it("rejects model changes while a thread run is active", async () => {
    const provider = new AgentWebviewProvider({ extensionUri: { path: "/extension" } } as never, {
      modelCatalog: new StaticModelCatalog([
        { id: "coding-primary", label: "Coding Primary", provider: "primary" },
        { id: "coding-fast", label: "Coding Fast", provider: "primary" },
      ]),
      threadModelStore: new FileThreadModelStore(),
      isThreadRunActive: () => true,
    });
    const view = createWebviewView();
    provider.resolveWebviewView(view as never);
    view.emit(
      createUiToExtensionMessage("ui-ready", {
        clientInstanceId: "00000000-0000-4000-8000-000000000002",
        supportedProtocolVersions: ["1.0"],
      }),
    );
    await flush();

    const selection = createUiToExtensionMessage("select-model", {
      threadId: "default",
      modelId: "coding-primary",
      expectedThreadRevision: 1,
    });
    view.emit(selection);
    await flush();

    expect(view.sent).toContainEqual(
      expect.objectContaining({
        type: "error",
        correlationId: selection.messageId,
        payload: expect.objectContaining({ code: "MODEL_SELECTION_BUSY" }),
      }),
    );
  });
});
