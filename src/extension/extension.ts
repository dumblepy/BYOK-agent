import type { ExtensionContext } from "vscode";

import { createApplicationServices, type ApplicationServices } from "./application-services";

let applicationServices: ApplicationServices | undefined;
let activationPromise: Promise<void> | undefined;

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

  activationPromise = createApplicationServices(context).then((services) => {
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
}
