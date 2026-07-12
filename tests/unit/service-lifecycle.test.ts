import { describe, expect, it } from "vitest";

import { DisposableStore, ManagedService } from "../../src/extension/service-lifecycle";

describe("ManagedService", () => {
  it("does not initialize or dispose more than once", async () => {
    let initializations = 0;
    let disposals = 0;
    const service = new (class extends ManagedService {
      protected override onInitialize(): void {
        initializations += 1;
      }

      protected override onDispose(): void {
        disposals += 1;
      }
    })();

    await Promise.all([service.initialize(), service.initialize()]);
    await Promise.all([service.dispose(), service.dispose()]);
    await service.dispose();

    expect(initializations).toBe(1);
    expect(disposals).toBe(1);
  });
});

describe("DisposableStore", () => {
  it("disposes resources in reverse order and continues after errors", async () => {
    const events: string[] = [];
    const store = new DisposableStore();

    store.add({
      dispose: () => {
        events.push("first");
      },
    });
    store.add({
      dispose: () => {
        events.push("second");
        throw new Error("second failed");
      },
    });
    store.add({
      dispose: () => {
        events.push("third");
      },
    });

    await expect(store.dispose()).rejects.toThrow("One or more disposables failed to dispose");
    expect(events).toEqual(["third", "second", "first"]);
    await store.dispose();
  });
});
