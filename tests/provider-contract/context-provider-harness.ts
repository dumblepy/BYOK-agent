import { computeContextContentHash, type ContextItem } from "../../src/context/context-item";
import type {
  ContextProvider,
  ContextRequest,
  ContextScope,
} from "../../src/context/context-provider";

export interface FakeContextProviderOptions {
  readonly items?: readonly ContextItem[];
  readonly delayMs?: number;
  readonly rejectWith?: unknown;
  readonly onCollect?: (request: ContextRequest, signal: AbortSignal) => void;
}

export interface FakeContextProviderObservation {
  readonly calls: readonly {
    request: ContextRequest;
    signal: AbortSignal;
  }[];
}

export function createFakeContextProvider(
  id: string,
  scopes: readonly ContextScope[],
  options: FakeContextProviderOptions = {},
): {
  readonly provider: ContextProvider;
  readonly observation: FakeContextProviderObservation;
} {
  const calls: Array<{ request: ContextRequest; signal: AbortSignal }> = [];
  return {
    provider: {
      id,
      scopes,
      async collect(request, signal) {
        calls.push({ request, signal });
        options.onCollect?.(request, signal);
        if (signal.aborted) {
          throw createAbortError();
        }

        if (options.delayMs !== undefined && options.delayMs > 0) {
          await wait(options.delayMs, signal);
        }

        if (options.rejectWith !== undefined) {
          throw options.rejectWith;
        }

        return options.items ?? [];
      },
    },
    observation: {
      get calls() {
        return calls;
      },
    },
  };
}

export function createContextItem(
  id: string,
  content: string,
  overrides: Partial<ContextItem> = {},
): ContextItem {
  return {
    id,
    kind: "file",
    source: overrides.source ?? "fake-provider",
    content,
    priority: overrides.priority ?? 100,
    estimatedTokens: overrides.estimatedTokens ?? 1,
    contentHash: overrides.contentHash ?? computeContextContentHash(content),
    volatile: overrides.volatile ?? false,
    sensitive: overrides.sensitive ?? false,
    ...(overrides.uri === undefined ? {} : { uri: overrides.uri }),
    ...(overrides.range === undefined ? {} : { range: overrides.range }),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
  };
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const abort = () => {
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
