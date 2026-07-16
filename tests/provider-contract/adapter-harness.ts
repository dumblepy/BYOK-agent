import { vi } from "vitest";

import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/provider-types";

export interface ProviderContractFixture {
  readonly chunks: readonly string[];
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ProviderContractCase {
  readonly id: string;
  readonly request: ProviderRequest;
  readonly fixture?: ProviderContractFixture;
  readonly expected?: readonly ProviderEvent[];
  readonly expectedError?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly status?: number;
  };
  readonly abort?: "before-request" | "during-stream";
}

export interface ProviderContractAdapterDefinition {
  readonly name: string;
  createAdapter(fetchImpl: typeof fetch): ProviderAdapter;
  readonly cases: readonly ProviderContractCase[];
}

export interface ProviderContractTransportObservation {
  readonly fetch: ReturnType<typeof vi.fn>;
  getSignal(): AbortSignal | undefined;
}

export function createFixtureFetch(
  fixture: ProviderContractFixture,
  abortDuringStream = false,
): {
  readonly fetchImpl: typeof fetch;
  readonly observation: ProviderContractTransportObservation;
} {
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    const encoder = new TextEncoder();
    let index = 0;
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < fixture.chunks.length) {
          controller.enqueue(encoder.encode(fixture.chunks[index++]));
          if (abortDuringStream && index === 1) {
            return new Promise<void>((resolve) => {
              release = () => {
                controller.close();
                resolve();
              };
              if (requestSignal?.aborted) release();
              else requestSignal?.addEventListener("abort", () => release?.(), { once: true });
            });
          }
          return;
        }
        controller.close();
      },
      cancel() {
        release?.();
      },
    });
    return new Response(body, {
      status: fixture.status ?? 200,
      headers: fixture.headers ?? { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl: fetchMock,
    observation: {
      fetch: fetchMock,
      getSignal: () => requestSignal,
    },
  };
}

export async function collectProviderEvents(
  adapter: ProviderAdapter,
  signal: AbortSignal,
  request: ProviderRequest,
  onEvent?: (event: ProviderEvent) => void,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.stream(request, signal)) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

export function defaultRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    requestId: "contract-request",
    modelId: "contract-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    options: {},
    ...overrides,
  };
}
