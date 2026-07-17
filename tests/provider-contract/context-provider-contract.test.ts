import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultContextCollector } from "../../src/context/context-collector";
import { ContextProviderConfigurationError } from "../../src/context/context-provider";
import { createContextItem, createFakeContextProvider } from "./context-provider-harness";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Context Provider Contract", () => {
  it("Fake Providerを使って複数ソースを登録順で収集できる", async () => {
    vi.useFakeTimers();
    const first = createFakeContextProvider("first", ["turn"], {
      delayMs: 20,
      items: [createContextItem("first-item", "first")],
    });
    const second = createFakeContextProvider("second", ["turn"], {
      delayMs: 0,
      items: [createContextItem("second-item", "second")],
    });

    const collector = new DefaultContextCollector({
      providerTimeoutMs: 1_000,
      providers: [first.provider, second.provider],
    });

    const result = collector.collect(
      {
        threadId: "thread-1",
        runId: "run-1",
        scope: "turn",
      },
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toEqual({
      status: "completed",
      items: [createContextItem("first-item", "first"), createContextItem("second-item", "second")],
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
    expect(first.observation.calls).toHaveLength(1);
    expect(second.observation.calls).toHaveLength(1);
  });

  it("Fake Providerの失敗、Timeout、Abortを個別Outcomeへ分離できる", async () => {
    vi.useFakeTimers();
    const slow = createFakeContextProvider("slow", ["turn"], {
      delayMs: 1_000,
      items: [createContextItem("slow-item", "slow")],
    });
    const broken = createFakeContextProvider("broken", ["turn"], {
      rejectWith: new Error("provider exploded"),
    });
    const fast = createFakeContextProvider("fast", ["turn"], {
      items: [createContextItem("fast-item", "fast")],
    });

    const collector = new DefaultContextCollector({
      providerTimeoutMs: 25,
      providers: [slow.provider, broken.provider, fast.provider],
    });

    const result = collector.collect(
      { threadId: "thread-1", scope: "turn" },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toEqual({
      status: "completed",
      items: [createContextItem("fast-item", "fast")],
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

    expect(slow.observation.calls).toHaveLength(1);
    expect(slow.observation.calls[0].signal.aborted).toBe(true);
  });

  it("不正なprovider定義は契約テスト基盤でも拒否される", () => {
    expect(
      () =>
        new DefaultContextCollector({
          providerTimeoutMs: 1_000,
          providers: [
            createFakeContextProvider("dup", ["turn"]).provider,
            createFakeContextProvider("dup", ["turn"]).provider,
          ],
        }),
    ).toThrow(ContextProviderConfigurationError);
  });
});
