import { describe, expect, it, vi, afterEach } from "vitest";

import { computeContextContentHash, type ContextItem } from "../../src/context/context-item";
import { DefaultContextCollector } from "../../src/context/context-collector";
import {
  ContextProviderConfigurationError,
  type ContextProvider,
  type ContextRequest,
} from "../../src/context/context-provider";
import type { DiagnosticLogger } from "../../src/observability/diagnostic-logger";

function createItem(id: string, content: string, source = "source"): ContextItem {
  return {
    id,
    kind: "file",
    source,
    content,
    priority: 100,
    estimatedTokens: 1,
    contentHash: computeContextContentHash(content),
    volatile: false,
    sensitive: false,
  };
}

function createProvider(
  id: string,
  scopes: readonly ContextRequest["scope"][],
  collect: ContextProvider["collect"],
): ContextProvider {
  return { id, scopes, collect };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies DiagnosticLogger;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DefaultContextCollector", () => {
  const request: ContextRequest = {
    threadId: "thread-1",
    runId: "run-1",
    scope: "turn",
  };

  it("register順で並列開始し、完了順ではなく登録順で集約する", async () => {
    const starts: string[] = [];
    const first = deferred<readonly ContextItem[]>();
    const second = deferred<readonly ContextItem[]>();

    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [
        createProvider("first", ["turn"], async (_request, _signal) => {
          starts.push("first");
          return first.promise;
        }),
        createProvider("second", ["turn"], async (_request, _signal) => {
          starts.push("second");
          return second.promise;
        }),
      ],
    });

    const collection = collector.collect(request, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(["first", "second"]);

    second.resolve([createItem("second-item", "second")]);
    first.resolve([createItem("first-item", "first")]);

    await expect(collection).resolves.toEqual({
      status: "completed",
      items: [createItem("first-item", "first"), createItem("second-item", "second")],
      providers: [
        {
          providerId: "first",
          status: "fulfilled",
          itemCount: 1,
          elapsedMs: expect.any(Number),
        },
        {
          providerId: "second",
          status: "fulfilled",
          itemCount: 1,
          elapsedMs: expect.any(Number),
        },
      ],
    });
  });

  it("provider単位の失敗とタイムアウトを他providerへ波及させない", async () => {
    vi.useFakeTimers();
    const controllerSeen: AbortSignal[] = [];
    const logger = createLogger();

    const collector = new DefaultContextCollector({
      providerTimeoutMs: 25,
      logger,
      providers: [
        createProvider("slow", ["turn"], async (_request, signal) => {
          controllerSeen.push(signal);
          return new Promise<readonly ContextItem[]>((resolve) => {
            signal.addEventListener("abort", () => resolve([createItem("slow-item", "slow")]), {
              once: true,
            });
          });
        }),
        createProvider("broken", ["turn"], async () => {
          throw new Error("provider exploded");
        }),
        createProvider("fast", ["turn"], async () => [createItem("fast-item", "fast")]),
      ],
    });

    const collection = collector.collect(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(25);

    await expect(collection).resolves.toEqual({
      status: "completed",
      items: [createItem("fast-item", "fast")],
      providers: [
        {
          providerId: "slow",
          status: "timed-out",
          itemCount: 0,
          elapsedMs: expect.any(Number),
          failureCode: "provider-timeout",
        },
        {
          providerId: "broken",
          status: "failed",
          itemCount: 0,
          elapsedMs: expect.any(Number),
          failureCode: "provider-failed",
        },
        {
          providerId: "fast",
          status: "fulfilled",
          itemCount: 1,
          elapsedMs: expect.any(Number),
        },
      ],
    });

    expect(controllerSeen).toHaveLength(1);
    expect(controllerSeen[0].aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("重複IDを含むprovider結果だけをinvalid-resultとして破棄する", async () => {
    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [
        createProvider("first", ["turn"], async () => [createItem("shared-id", "first")]),
        createProvider("second", ["turn"], async () => [createItem("shared-id", "second")]),
      ],
    });

    await expect(collector.collect(request, new AbortController().signal)).resolves.toEqual({
      status: "completed",
      items: [createItem("shared-id", "first")],
      providers: [
        {
          providerId: "first",
          status: "fulfilled",
          itemCount: 1,
          elapsedMs: expect.any(Number),
        },
        {
          providerId: "second",
          status: "invalid-result",
          itemCount: 0,
          elapsedMs: expect.any(Number),
          failureCode: "invalid-result",
        },
      ],
    });
  });

  it("親AbortSignalの事前中断ではproviderを呼び出さない", async () => {
    const provider = vi.fn(async () => [createItem("ignored", "ignored")]);
    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [createProvider("only", ["turn"], provider)],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(collector.collect(request, controller.signal)).resolves.toEqual({
      status: "cancelled",
      items: [],
      providers: [],
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("親AbortSignalの中断時に部分結果を返さない", async () => {
    const aborted = deferred<void>();
    const signalSeen: AbortSignal[] = [];
    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [
        createProvider("waiting", ["turn"], async (_request, signal) => {
          signalSeen.push(signal);
          await aborted.promise;
          return [createItem("late", "late")];
        }),
      ],
    });

    const controller = new AbortController();
    const collection = collector.collect(request, controller.signal);
    await Promise.resolve();
    controller.abort();
    aborted.resolve();

    await expect(collection).resolves.toEqual({
      status: "cancelled",
      items: [],
      providers: [],
    });
    expect(signalSeen).toHaveLength(1);
    expect(signalSeen[0].aborted).toBe(true);
  });

  it("scopeに一致するproviderだけを選択する", async () => {
    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [
        createProvider("static", ["static"], async () => [createItem("static", "static")]),
        createProvider("turn", ["turn"], async () => [createItem("turn", "turn")]),
      ],
    });

    await expect(collector.collect(request, new AbortController().signal)).resolves.toEqual({
      status: "completed",
      items: [createItem("turn", "turn")],
      providers: [
        {
          providerId: "turn",
          status: "fulfilled",
          itemCount: 1,
          elapsedMs: expect.any(Number),
        },
      ],
    });
  });

  it("provider設定の重複IDを拒否する", () => {
    expect(
      () =>
        new DefaultContextCollector({
          providerTimeoutMs: 1_000,
          providers: [
            createProvider("dup", ["turn"], async () => []),
            createProvider("dup", ["turn"], async () => []),
          ],
        }),
    ).toThrow(ContextProviderConfigurationError);
  });
});
