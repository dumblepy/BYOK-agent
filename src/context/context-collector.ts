import { parseContextItem, type ContextItem } from "./context-item";
import {
  type ContextCollectionResult,
  type ContextCollector,
  ContextProviderConfigurationError,
  type ContextProvider,
  type ContextProviderOutcome,
  type ContextProviderStatus,
  type ContextRequest,
  type ContextScope,
  validateContextProvider,
  validateContextRequest,
} from "./context-provider";
import type { DiagnosticLogger } from "../observability/diagnostic-logger";

export interface ContextCollectorDependencies {
  readonly providers: readonly ContextProvider[];
  readonly providerTimeoutMs?: number;
  readonly logger?: DiagnosticLogger;
}

interface ProviderRunResult {
  readonly providerId: string;
  readonly outcome: ContextProviderOutcome;
  readonly items: readonly ContextItem[];
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_ITEMS = 1_000;

export class DefaultContextCollector implements ContextCollector {
  private readonly providers: readonly ContextProvider[];
  private readonly providerTimeoutMs: number;
  private readonly logger?: DiagnosticLogger;

  public constructor(dependencies: ContextCollectorDependencies) {
    this.providers = validateProviders(dependencies.providers);
    this.providerTimeoutMs = validateTimeoutMs(
      dependencies.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    this.logger = dependencies.logger;
  }

  public async collect(
    request: ContextRequest,
    signal: AbortSignal,
  ): Promise<ContextCollectionResult> {
    validateContextRequest(request);
    if (signal.aborted) {
      return { status: "cancelled", items: [], providers: [] };
    }

    const selectedProviders = this.selectProviders(request.scope);
    const providerRuns = selectedProviders.map((provider) =>
      this.runProvider(provider, request, signal),
    );
    const allRunsPromise = Promise.all(providerRuns);
    const abortSubscription = createAbortPromise(signal);

    try {
      const race = await Promise.race([
        allRunsPromise.then((runs) => ({ kind: "completed" as const, runs })),
        abortSubscription.promise,
      ]);

      if (race.kind === "aborted" || signal.aborted) {
        return { status: "cancelled", items: [], providers: [] };
      }

      const items: ContextItem[] = [];
      const providers: ContextProviderOutcome[] = [];
      const seenIds = new Set<string>();

      for (const run of race.runs) {
        if (run.outcome.status !== "fulfilled") {
          providers.push(run.outcome);
          continue;
        }

        const validated = validateCollectedItems(run.items, seenIds);
        if (!validated.ok) {
          const outcome = createOutcome(
            run.providerId,
            "invalid-result",
            0,
            run.outcome.elapsedMs,
            "invalid-result",
          );
          providers.push(outcome);
          this.logOutcome(outcome);
          continue;
        }

        items.push(...validated.items);
        const outcome = createOutcome(
          run.providerId,
          "fulfilled",
          validated.items.length,
          run.outcome.elapsedMs,
        );
        providers.push(outcome);
        this.logOutcome(outcome);
      }

      return { status: "completed", items, providers };
    } finally {
      abortSubscription.dispose();
    }
  }

  private selectProviders(scope: ContextScope): readonly ContextProvider[] {
    return this.providers.filter((provider) => provider.scopes.includes(scope));
  }

  private async runProvider(
    provider: ContextProvider,
    request: ContextRequest,
    parentSignal: AbortSignal,
  ): Promise<ProviderRunResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const releaseAbort = forwardAbort(parentSignal, controller);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const completion = Promise.resolve()
      .then(() => provider.collect(request, controller.signal))
      .then(
        (items) => ({ kind: "fulfilled" as const, items }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.providerTimeoutMs);
    });

    try {
      const settled = await Promise.race([completion, timeout]);
      const elapsedMs = Math.max(0, Date.now() - startedAt);

      if (settled.kind === "timeout") {
        const outcome = createOutcome(provider.id, "timed-out", 0, elapsedMs, "provider-timeout");
        this.logOutcome(outcome);
        return { providerId: provider.id, outcome, items: [] };
      }

      if (settled.kind === "rejected") {
        const failureCode =
          timedOut || controller.signal.aborted
            ? "provider-timeout"
            : classifyProviderError(settled.error, parentSignal);
        const status =
          failureCode === "provider-timeout"
            ? "timed-out"
            : failureCode === "provider-cancelled"
              ? "cancelled"
              : "failed";
        const outcome = createOutcome(provider.id, status, 0, elapsedMs, failureCode);
        this.logOutcome(outcome);
        return { providerId: provider.id, outcome, items: [] };
      }

      if (parentSignal.aborted) {
        const outcome = createOutcome(provider.id, "cancelled", 0, elapsedMs, "provider-cancelled");
        this.logOutcome(outcome);
        return { providerId: provider.id, outcome, items: [] };
      }

      const validated = validateCollectedItems(settled.items, new Set<string>());
      if (!validated.ok) {
        const outcome = createOutcome(
          provider.id,
          "invalid-result",
          0,
          elapsedMs,
          "invalid-result",
        );
        this.logOutcome(outcome);
        return { providerId: provider.id, outcome, items: [] };
      }

      const outcome = createOutcome(provider.id, "fulfilled", validated.items.length, elapsedMs);
      return { providerId: provider.id, outcome, items: validated.items };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      releaseAbort();
    }
  }

  private logOutcome(outcome: ContextProviderOutcome): void {
    if (!this.logger) return;

    const fields = {
      providerId: outcome.providerId,
      status: outcome.status,
      itemCount: outcome.itemCount,
      elapsedMs: outcome.elapsedMs,
      ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
    };

    if (outcome.status === "fulfilled") {
      this.logger.info("context-provider-outcome", fields);
      return;
    }

    this.logger.warn("context-provider-outcome", fields);
  }
}

function validateProviders(providers: readonly ContextProvider[]): readonly ContextProvider[] {
  if (!Array.isArray(providers)) {
    throw new ContextProviderConfigurationError("providers must be an array");
  }

  const seenIds = new Set<string>();
  for (const provider of providers) {
    validateContextProvider(provider);
    if (seenIds.has(provider.id)) {
      throw new ContextProviderConfigurationError(`duplicate ContextProvider id: ${provider.id}`);
    }
    seenIds.add(provider.id);
  }

  return [...providers];
}

function validateTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ContextProviderConfigurationError(
      "providerTimeoutMs must be a positive finite number",
    );
  }
  return timeoutMs;
}

function createAbortPromise(signal: AbortSignal): {
  readonly promise: Promise<{ kind: "aborted" }>;
  readonly dispose: () => void;
} {
  if (signal.aborted) {
    return { promise: Promise.resolve({ kind: "aborted" }), dispose: () => undefined };
  }

  let resolveAbort: ((value: { kind: "aborted" }) => void) | undefined;
  const promise = new Promise<{ kind: "aborted" }>((resolve) => {
    resolveAbort = resolve;
  });
  const abort = () => resolveAbort?.({ kind: "aborted" });
  signal.addEventListener("abort", abort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort();
  if (source.aborted) target.abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function validateCollectedItems(
  input: readonly ContextItem[] | unknown,
  seenIds: Set<string>,
): { readonly ok: true; readonly items: readonly ContextItem[] } | { readonly ok: false } {
  if (!Array.isArray(input)) {
    return { ok: false };
  }
  if (input.length > MAX_PROVIDER_ITEMS) {
    return { ok: false };
  }

  const items: ContextItem[] = [];
  const providerIds = new Set<string>();
  for (const candidate of input) {
    let item: ContextItem;
    try {
      item = parseContextItem(candidate);
    } catch {
      return { ok: false };
    }

    if (providerIds.has(item.id) || seenIds.has(item.id)) {
      return { ok: false };
    }

    providerIds.add(item.id);
    seenIds.add(item.id);
    items.push(item);
  }

  return { ok: true, items };
}

function createOutcome(
  providerId: string,
  status: ContextProviderStatus,
  itemCount: number,
  elapsedMs: number,
  failureCode?: ContextProviderOutcome["failureCode"],
): ContextProviderOutcome {
  return {
    providerId,
    status,
    itemCount,
    elapsedMs,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}

function classifyProviderError(
  error: unknown,
  parentSignal: AbortSignal,
): "provider-failed" | "provider-cancelled" {
  if (parentSignal.aborted) {
    return "provider-cancelled";
  }

  if (isAbortLikeError(error)) {
    return "provider-cancelled";
  }

  return "provider-failed";
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
