import * as vscode from "vscode";

import { AgentWebviewProvider } from "./agent-webview-provider";
import {
  DisposableStore,
  ManagedService,
  type DisposableLike,
} from "../extension/service-lifecycle";
import type { AgentService } from "../agent/agent-service";
import type { StorageService } from "../storage/storage-service";

const AGENT_VIEW_ID = "byokAgent.view";
type WebviewViewProviderRegistrationOptions = Parameters<
  typeof vscode.window.registerWebviewViewProvider
>[2];

export interface UIService extends ManagedService {
  readonly serviceName: "ui";
}

export interface UIServiceDependencies {
  readonly context: vscode.ExtensionContext;
  readonly agent: AgentService;
  readonly storage: StorageService;
  readonly registerWebviewViewProvider: (
    viewId: string,
    provider: vscode.WebviewViewProvider,
    options?: WebviewViewProviderRegistrationOptions,
  ) => vscode.Disposable;
}

/** Owns VS Code UI registrations and keeps the Webview boundary free of application services. */
export class DefaultUIService extends ManagedService implements UIService {
  public readonly serviceName = "ui" as const;

  private readonly disposables = new DisposableStore();

  public constructor(private readonly dependencies: UIServiceDependencies) {
    super();
  }

  protected override onInitialize(): void {
    const provider = new AgentWebviewProvider(this.dependencies.context);
    const registration = this.dependencies.registerWebviewViewProvider(AGENT_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: false,
      },
    });
    this.disposables.add(registration as DisposableLike);

    // UI receives service interfaces only; it never receives Provider or Storage implementations.
    void this.dependencies.agent;
    void this.dependencies.storage;
  }

  protected override onDispose(): Promise<void> {
    return this.disposables.dispose();
  }
}
