import { normalizeProviderError } from "./provider-error";
import type { ProviderError, ProviderEvent, ProviderRequest } from "./provider-types";

export interface ProviderRetryExecution {
  readonly runId?: string;
  readonly request: ProviderRequest;
  readonly toolRisk?: boolean;
  readonly execute: (
    request: ProviderRequest,
    attempt: number,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}

export interface ProviderRetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxTotalDelayMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ProviderRetryPolicy {
  execute(input: ProviderRetryExecution, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

const RETRYABLE_CODES = new Set<ProviderError["code"]>(["rate-limited", "timeout", "network"]);

interface Subscriber {
  readonly events: ProviderEvent[];
  readonly waiters: Array<(result: IteratorResult<ProviderEvent>) => void>;
  closed: boolean;
}

interface Flight {
  readonly controller: AbortController;
  readonly ownerSignal: AbortSignal;
  readonly subscribers: Set<Subscriber>;
  readonly history: ProviderEvent[];
  completed: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<ProviderRetryPolicyOptions, "sleep" | "random">> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxTotalDelayMs: 15_000,
  jitterRatio: 0.2,
};

export class DefaultProviderRetryPolicy implements ProviderRetryPolicy {
  private readonly flights = new Map<string, Flight>();
  private readonly options: Required<ProviderRetryPolicyOptions>;

  public constructor(options: ProviderRetryPolicyOptions = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    this.options = {
      ...merged,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? sleep,
    };
    validateOptions(this.options);
  }

  public execute(input: ProviderRetryExecution, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const key = `${input.runId ?? input.request.requestId}:${input.request.requestId}`;
    let flight = this.flights.get(key);
    if (!flight) {
      flight = createFlight(signal);
      this.flights.set(key, flight);
      void this.runFlight(flight, input).finally(() => {
        flight!.completed = true;
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    }
    return subscribe(flight, signal);
  }

  private async runFlight(flight: Flight, input: ProviderRetryExecution): Promise<void> {
    const toolRisk =
      input.toolRisk ??
      (input.request.tools.length > 0 ||
        input.request.messages.some((message) => (message.toolCalls?.length ?? 0) > 0));
    let totalDelayMs = 0;

    for (let attempt = 0; attempt < this.options.maxAttempts; attempt += 1) {
      if (flight.controller.signal.aborted) {
        publish(flight, { type: "cancelled" });
        return;
      }

      let published = false;
      let shouldRetry = false;
      try {
        for await (const event of input.execute(input.request, attempt, flight.controller.signal)) {
          if (flight.controller.signal.aborted) {
            publish(flight, { type: "cancelled" });
            return;
          }

          if (event.type === "error") {
            if (
              canRetry(event.error, {
                attempt,
                published,
                toolRisk,
                totalDelayMs,
                maxAttempts: this.options.maxAttempts,
              })
            ) {
              const delayMs = calculateDelay(event.error.retryAfterMs, attempt, this.options);
              if (totalDelayMs + delayMs <= this.options.maxTotalDelayMs) {
                totalDelayMs += delayMs;
                try {
                  await this.options.sleep(delayMs, flight.controller.signal);
                } catch {
                  publish(flight, { type: "cancelled" });
                  return;
                }
                shouldRetry = true;
                break;
              }
            }
            publish(flight, event);
            return;
          }

          if (event.type === "cancelled") {
            publish(flight, event);
            return;
          }

          published = true;
          publish(flight, event);
          if (event.type === "completed") return;
        }
      } catch (error) {
        const normalized = normalizeProviderError(error, { signal: flight.controller.signal });
        if (
          canRetry(normalized, {
            attempt,
            published,
            toolRisk,
            totalDelayMs,
            maxAttempts: this.options.maxAttempts,
          })
        ) {
          const delayMs = calculateDelay(normalized.retryAfterMs, attempt, this.options);
          if (totalDelayMs + delayMs <= this.options.maxTotalDelayMs) {
            totalDelayMs += delayMs;
            try {
              await this.options.sleep(delayMs, flight.controller.signal);
            } catch {
              publish(flight, { type: "cancelled" });
              return;
            }
            continue;
          }
        }
        publish(flight, { type: "error", error: normalized });
        return;
      }

      if (shouldRetry) continue;
      if (!published) {
        closeFlight(flight);
        return;
      }
    }
    closeFlight(flight);
  }
}

function createFlight(sourceSignal: AbortSignal): Flight {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (sourceSignal.aborted) controller.abort();
  else sourceSignal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    ownerSignal: sourceSignal,
    subscribers: new Set(),
    history: [],
    completed: false,
  };
}

function subscribe(flight: Flight, signal: AbortSignal): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      const subscriber: Subscriber = { events: [...flight.history], waiters: [], closed: false };
      flight.subscribers.add(subscriber);
      if (flight.completed || isTerminalEvent(flight.history.at(-1))) closeSubscriber(subscriber);
      const abort = () => {
        if (signal === flight.ownerSignal) flight.controller.abort();
        else closeSubscriber(subscriber);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      try {
        while (!subscriber.closed || subscriber.events.length > 0) {
          if (subscriber.events.length === 0) {
            const next = await new Promise<IteratorResult<ProviderEvent>>((resolve) => {
              subscriber.waiters.push(resolve);
            });
            if (next.done) return;
            yield next.value;
          } else {
            yield subscriber.events.shift()!;
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        flight.subscribers.delete(subscriber);
        if (flight.subscribers.size === 0 && !flight.completed) flight.controller.abort();
      }
    },
  };
}

function publish(flight: Flight, event: ProviderEvent): void {
  flight.history.push(event);
  for (const subscriber of flight.subscribers) {
    if (subscriber.closed) continue;
    const waiter = subscriber.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else subscriber.events.push(event);
  }
  if (event.type === "error" || event.type === "cancelled" || event.type === "completed") {
    for (const subscriber of flight.subscribers) closeSubscriber(subscriber);
  }
}

function closeFlight(flight: Flight): void {
  for (const subscriber of flight.subscribers) closeSubscriber(subscriber);
}

function isTerminalEvent(event: ProviderEvent | undefined): boolean {
  return event?.type === "error" || event?.type === "cancelled" || event?.type === "completed";
}

function closeSubscriber(subscriber: Subscriber): void {
  if (subscriber.closed) return;
  subscriber.closed = true;
  for (const waiter of subscriber.waiters.splice(0)) waiter({ done: true, value: undefined });
}

function canRetry(
  error: ProviderError,
  context: {
    attempt: number;
    published: boolean;
    toolRisk: boolean;
    totalDelayMs: number;
    maxAttempts: number;
  },
): boolean {
  if (
    !error.retryable ||
    !RETRYABLE_CODES.has(error.code) ||
    context.published ||
    context.attempt >= context.maxAttempts - 1
  ) {
    return false;
  }
  if (!context.toolRisk) return true;
  return (
    error.deliveryStatus === "not-sent" || error.deliveryStatus === "rejected-before-processing"
  );
}

function calculateDelay(
  retryAfterMs: number | undefined,
  retryIndex: number,
  options: Required<ProviderRetryPolicyOptions>,
): number {
  const exponential = options.baseDelayMs * 2 ** retryIndex;
  const baseDelay = Math.max(exponential, retryAfterMs ?? 0);
  const jitter = baseDelay * options.jitterRatio * clamp(options.random(), 0, 1);
  return Math.min(options.maxDelayMs, Math.ceil(baseDelay + jitter));
}

function validateOptions(options: Required<ProviderRetryPolicyOptions>): void {
  if (
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isFinite(options.baseDelayMs) ||
    options.baseDelayMs < 0 ||
    !Number.isFinite(options.maxDelayMs) ||
    options.maxDelayMs < 0 ||
    !Number.isFinite(options.maxTotalDelayMs) ||
    options.maxTotalDelayMs < 0 ||
    !Number.isFinite(options.jitterRatio) ||
    options.jitterRatio < 0 ||
    options.jitterRatio > 1
  ) {
    throw new Error("Provider Retry Policyの設定値が不正です。");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(activeTimer);
      reject(new Error("aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    const complete = () => {
      cleanup();
      resolve();
    };
    const activeTimer = setTimeout(complete, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      clearTimeout(activeTimer);
      abort();
    }
  });
}
