import { createProviderError, normalizeProviderError } from "../provider-error";
import type { ProviderAdapter, ProviderEvent, ProviderRequest } from "../provider-types";
import type { ProviderAdapterFactory, ProviderAdapterInit } from "../provider-router";
import { normalizeResponsesEvents } from "./openai-responses-events";
import { toResponsesRequest, ResponsesRequestMappingError } from "./openai-responses-request";
import { parseResponsesSse, ResponsesSsePayloadTooLargeError } from "./openai-responses-sse";

export interface OpenAIResponsesAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  public readonly type = "responses";

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(
    private readonly init: ProviderAdapterInit,
    options: OpenAIResponsesAdapterOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  }

  public stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    return this.streamInternal(request, signal);
  }

  private async *streamInternal(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    if (signal.aborted) {
      yield { type: "cancelled" };
      return;
    }

    const operation = createOperationSignal(signal, this.timeoutMs);
    try {
      const body = JSON.stringify(toResponsesRequest(request));
      const response = await this.fetchImpl(this.init.url, {
        method: "POST",
        headers: createHeaders(this.init.headers, this.init.credential),
        body,
        redirect: "error",
        signal: operation.signal,
      });

      if (signal.aborted) {
        yield { type: "cancelled" };
        return;
      }

      if (!response.ok) {
        yield {
          type: "error",
          error: normalizeProviderError(
            {
              status: response.status,
              retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")),
              requestId: response.headers.get("x-request-id") ?? request.requestId,
            },
            { requestId: request.requestId },
          ),
        };
        return;
      }

      if (!response.body) {
        yield {
          type: "error",
          error: createProviderError("bad-request", request.requestId),
        };
        return;
      }

      const toolNames = new Set(request.tools.map((tool) => tool.name));
      const events = parseResponsesSse(response.body, operation.signal, this.maxResponseBytes);
      for await (const event of normalizeResponsesEvents(
        events,
        request.requestId,
        toolNames,
        operation.signal,
      )) {
        if (event.type === "cancelled" && operation.timedOut && !signal.aborted) {
          yield { type: "error", error: createProviderError("timeout", request.requestId) };
        } else {
          yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        yield { type: "cancelled" };
        return;
      }
      if (operation.timedOut) {
        yield { type: "error", error: createProviderError("timeout", request.requestId) };
        return;
      }
      yield {
        type: "error",
        error:
          error instanceof ResponsesRequestMappingError ||
          error instanceof ResponsesSsePayloadTooLargeError
            ? createProviderError("bad-request", request.requestId)
            : normalizeProviderError(error, { requestId: request.requestId }),
      };
    } finally {
      operation.dispose();
    }
  }
}

export class OpenAIResponsesAdapterFactory implements ProviderAdapterFactory {
  public readonly apiType = "responses" as const;

  public constructor(private readonly options: OpenAIResponsesAdapterOptions = {}) {}

  public async create(input: ProviderAdapterInit): Promise<ProviderAdapter> {
    return new OpenAIResponsesAdapter(input, this.options);
  }
}

function createHeaders(
  configuredHeaders: Readonly<Record<string, string>>,
  credential: string | undefined,
): Headers {
  const headers = new Headers(configuredHeaders);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (credential !== undefined && credential.length > 0) {
    headers.set("authorization", `Bearer ${credential}`);
  }
  return headers;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1000) {
    return undefined;
  }
  return seconds * 1000;
}

interface OperationSignal {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

function createOperationSignal(source: AbortSignal, timeoutMs: number): OperationSignal {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromSource = () => controller.abort();
  source.addEventListener("abort", abortFromSource, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  if (source.aborted) controller.abort();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      source.removeEventListener("abort", abortFromSource);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
