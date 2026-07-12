import type { ExtensionContext } from "vscode";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    registerWebviewViewProvider: vi.fn(),
  },
}));

import {
  createApplicationServices,
  type ApplicationServiceFactories,
} from "../../src/extension/application-services";
import { ManagedService } from "../../src/extension/service-lifecycle";
import type { AgentService } from "../../src/agent/agent-service";
import type { ProviderService } from "../../src/providers/provider-service";
import type { StorageService } from "../../src/storage/storage-service";
import type { UIService, UIServiceDependencies } from "../../src/ui/ui-service";

const context = {} as ExtensionContext;

class RecordingService extends ManagedService {
  public constructor(
    public readonly serviceName: "provider" | "storage" | "agent" | "ui",
    private readonly events: string[],
    private readonly failure?: Error,
    private readonly disposalFailure?: Error,
  ) {
    super();
  }

  protected override onInitialize(): void {
    this.events.push(`${this.serviceName}:initialize`);
    if (this.failure) {
      throw this.failure;
    }
  }

  protected override onDispose(): void {
    this.events.push(`${this.serviceName}:dispose`);
    if (this.disposalFailure) {
      throw this.disposalFailure;
    }
  }
}

function createFactories(
  events: string[],
  options: {
    readonly failingService?: "provider" | "storage" | "agent" | "ui";
    readonly disposalFailure?: "provider" | "storage" | "agent" | "ui";
  } = {},
): ApplicationServiceFactories {
  const service = (name: "provider" | "storage" | "agent" | "ui") =>
    new RecordingService(
      name,
      events,
      options.failingService === name ? new Error(`${name} failed`) : undefined,
      options.disposalFailure === name ? new Error(`${name} dispose failed`) : undefined,
    );

  return {
    provider: () => service("provider") as ProviderService,
    storage: () => service("storage") as StorageService,
    agent: ({ provider, storage }) => {
      expect(provider.serviceName).toBe("provider");
      expect(storage.serviceName).toBe("storage");
      return service("agent") as AgentService;
    },
    ui: ({ agent, storage }: UIServiceDependencies) => {
      expect(agent.serviceName).toBe("agent");
      expect(storage.serviceName).toBe("storage");
      return service("ui") as UIService;
    },
  };
}

describe("createApplicationServices", () => {
  it("initializes the dependency graph and disposes it in reverse order", async () => {
    const events: string[] = [];
    const services = await createApplicationServices(context, createFactories(events));

    expect(events).toEqual([
      "provider:initialize",
      "storage:initialize",
      "agent:initialize",
      "ui:initialize",
    ]);

    await services.dispose();
    expect(events).toEqual([
      "provider:initialize",
      "storage:initialize",
      "agent:initialize",
      "ui:initialize",
      "ui:dispose",
      "agent:dispose",
      "storage:dispose",
      "provider:dispose",
    ]);
  });

  it.each(["agent", "ui"] as const)(
    "rolls back every created service when %s initialization fails",
    async (failingService) => {
      const events: string[] = [];

      await expect(
        createApplicationServices(context, createFactories(events, { failingService })),
      ).rejects.toThrow(`${failingService} failed`);

      const expectedEvents = [
        "provider:initialize",
        "storage:initialize",
        "agent:initialize",
        "agent:dispose",
        "storage:dispose",
        "provider:dispose",
      ];
      if (failingService === "ui") {
        expectedEvents.splice(3, 0, "ui:initialize", "ui:dispose");
      }
      expect(events).toEqual(expectedEvents);
    },
  );

  it("continues disposal after one service reports an error", async () => {
    const events: string[] = [];
    const services = await createApplicationServices(
      context,
      createFactories(events, { disposalFailure: "ui" }),
    );

    await expect(services.dispose()).rejects.toThrow(
      "One or more application services failed to dispose",
    );
    expect(events.slice(-4)).toEqual([
      "ui:dispose",
      "agent:dispose",
      "storage:dispose",
      "provider:dispose",
    ]);
  });

  it("makes disposal idempotent", async () => {
    const events: string[] = [];
    const services = await createApplicationServices(context, createFactories(events));

    await Promise.all([services.dispose(), services.dispose()]);
    expect(events.filter((event) => event.endsWith(":dispose"))).toHaveLength(4);
  });
});
