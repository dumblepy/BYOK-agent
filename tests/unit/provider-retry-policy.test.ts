import { describe, expect, it, vi } from "vitest";

import { createProviderError } from "../../src/providers/provider-error";
import { DefaultProviderRetryPolicy } from "../../src/providers/provider-retry-policy";
import type { ProviderEvent, ProviderRequest } from "../../src/providers/provider-types";

const request: ProviderRequest = {
  requestId: "retry-request",
  modelId: "coding-primary",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  options: {},
};

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function error(
  code: "rate-limited" | "timeout" | "network" | "auth-failed" = "rate-limited",
  deliveryStatus?: "not-sent" | "rejected-before-processing",
) {
  return createProviderError(code, request.requestId, {
    ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
  });
}

describe("DefaultProviderRetryPolicy", () => {
  it("一時的エラーだけを指数バックオフで最大3試行する", async () => {
    const attempts: number[] = [];
    const delays: number[] = [];
    const policy = new DefaultProviderRetryPolicy({
      random: () => 0,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    const events = policy.execute(
      {
        request,
        execute: async function* (_request, attempt) {
          attempts.push(attempt);
          if (attempt < 2) {
            yield { type: "error", error: error() };
            return;
          }
          yield { type: "completed", stopReason: "end-turn" };
        },
      },
      new AbortController().signal,
    );

    await expect(collect(events)).resolves.toEqual([{ type: "completed", stopReason: "end-turn" }]);
    expect(attempts).toEqual([0, 1, 2]);
    expect(delays).toEqual([250, 500]);
  });

  it("Retry-Afterを指数バックオフの下限として上限内で使う", async () => {
    const delays: number[] = [];
    const policy = new DefaultProviderRetryPolicy({
      random: () => 0,
      sleep: async (delay) => delays.push(delay),
    });

    await collect(
      policy.execute(
        {
          request,
          execute: async function* (_request, attempt) {
            if (attempt === 0) {
              yield {
                type: "error",
                error: { ...error(), retryAfterMs: 2_000 },
              };
              return;
            }
            yield { type: "completed", stopReason: "end-turn" };
          },
        },
        new AbortController().signal,
      ),
    );

    expect(delays).toEqual([2_000]);
  });

  it("認証エラーを再試行しない", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "error", error: error("auth-failed") };
    });
    const policy = new DefaultProviderRetryPolicy({ sleep: async () => undefined });

    await expect(
      collect(policy.execute({ request, execute }, new AbortController().signal)),
    ).resolves.toEqual([{ type: "error", error: error("auth-failed") }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("Tool Riskの要求は未送信または処理開始前拒否だけを再試行する", async () => {
    const attempts: number[] = [];
    const policy = new DefaultProviderRetryPolicy({ sleep: async () => undefined });

    const safe = await collect(
      policy.execute(
        {
          request: { ...request, tools: [{ name: "read", inputSchema: {} }] },
          execute: async function* (_request, attempt) {
            attempts.push(attempt);
            if (attempt === 0) {
              yield {
                type: "error",
                error: error("rate-limited", "rejected-before-processing"),
              };
              return;
            }
            yield { type: "completed", stopReason: "tool-call" };
          },
        },
        new AbortController().signal,
      ),
    );

    const unsafe = await collect(
      policy.execute(
        {
          request: {
            ...request,
            requestId: "unsafe-tool-request",
            tools: [{ name: "read", inputSchema: {} }],
          },
          execute: async function* () {
            yield { type: "error", error: error("network") };
          },
        },
        new AbortController().signal,
      ),
    );

    expect(safe).toEqual([{ type: "completed", stopReason: "tool-call" }]);
    expect(unsafe).toHaveLength(1);
    expect(attempts).toEqual([0, 1]);
  });

  it("外部へイベントを公開した試行を再送しない", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "text-delta", text: "partial" };
      yield { type: "error", error: error("network") };
    });
    const policy = new DefaultProviderRetryPolicy({ sleep: async () => undefined });

    await expect(
      collect(policy.execute({ request, execute }, new AbortController().signal)),
    ).resolves.toEqual([
      { type: "text-delta", text: "partial" },
      { type: "error", error: error("network") },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("同じrunIdとrequestIdの並行要求をsingle-flightへ合流させる", async () => {
    let calls = 0;
    const execute = vi.fn(async function* () {
      calls += 1;
      await Promise.resolve();
      yield { type: "completed", stopReason: "end-turn" };
    });
    const policy = new DefaultProviderRetryPolicy({ sleep: async () => undefined });
    const signal = new AbortController().signal;
    const first = policy.execute({ runId: "run-1", request, execute }, signal);
    const second = policy.execute({ runId: "run-1", request, execute }, signal);

    await expect(Promise.all([collect(first), collect(second)])).resolves.toEqual([
      [{ type: "completed", stopReason: "end-turn" }],
      [{ type: "completed", stopReason: "end-turn" }],
    ]);
    expect(calls).toBe(1);
  });

  it("待機中のAbortで再試行と後続イベントを抑止する", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const policy = new DefaultProviderRetryPolicy({
      sleep: async (_delay, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        throw new Error("aborted");
      },
    });

    const events = await collect(
      policy.execute(
        {
          request,
          execute: async function* () {
            attempts += 1;
            yield { type: "error", error: error("timeout") };
          },
        },
        controller.signal,
      ),
    );

    expect(events).toEqual([{ type: "cancelled" }]);
    expect(attempts).toBe(1);
  });
});
