import type { ContextItem } from "./context-item";

export type ContextScope = "static" | "turn" | "execution";

export interface ContextRequest {
  readonly threadId: string;
  readonly runId?: string;
  readonly scope: ContextScope;
}

export interface ContextProvider {
  readonly id: string;
  readonly scopes: readonly ContextScope[];

  collect(request: ContextRequest, signal: AbortSignal): Promise<readonly ContextItem[]>;
}

export type ContextProviderStatus =
  "fulfilled" | "failed" | "timed-out" | "cancelled" | "invalid-result";

export type ContextProviderFailureCode =
  "provider-failed" | "provider-timeout" | "provider-cancelled" | "invalid-result";

export interface ContextProviderOutcome {
  readonly providerId: string;
  readonly status: ContextProviderStatus;
  readonly itemCount: number;
  readonly elapsedMs: number;
  readonly failureCode?: ContextProviderFailureCode;
}

export interface ContextCollectionResult {
  readonly status: "completed" | "cancelled";
  readonly items: readonly ContextItem[];
  readonly providers: readonly ContextProviderOutcome[];
}

export interface ContextCollector {
  collect(request: ContextRequest, signal: AbortSignal): Promise<ContextCollectionResult>;
}

export class ContextProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextProviderConfigurationError";
  }
}

const CONTEXT_SCOPE_SET = new Set<ContextScope>(["static", "turn", "execution"]);
const SAFE_IDENTIFIER_MAX_LENGTH = 256;

export function isContextScope(value: unknown): value is ContextScope {
  return typeof value === "string" && CONTEXT_SCOPE_SET.has(value as ContextScope);
}

export function validateContextRequest(request: ContextRequest): void {
  if (!isRecord(request)) {
    throw new ContextProviderConfigurationError("ContextRequest must be an object");
  }

  requireSafeIdentifier(request.threadId, "threadId");
  if (request.runId !== undefined) {
    requireSafeIdentifier(request.runId, "runId");
  }
  if (!isContextScope(request.scope)) {
    throw new ContextProviderConfigurationError("ContextRequest.scope must be a supported scope");
  }
}

export function validateContextProvider(provider: ContextProvider): void {
  if (!isRecord(provider)) {
    throw new ContextProviderConfigurationError("ContextProvider must be an object");
  }

  requireSafeIdentifier(provider.id, "provider.id");
  if (!Array.isArray(provider.scopes) || provider.scopes.length === 0) {
    throw new ContextProviderConfigurationError(
      `ContextProvider ${provider.id} must declare at least one supported scope`,
    );
  }

  const seenScopes = new Set<ContextScope>();
  for (const scope of provider.scopes) {
    if (!isContextScope(scope)) {
      throw new ContextProviderConfigurationError(
        `ContextProvider ${provider.id} contains an unsupported scope`,
      );
    }
    if (seenScopes.has(scope)) {
      throw new ContextProviderConfigurationError(
        `ContextProvider ${provider.id} contains a duplicate scope`,
      );
    }
    seenScopes.add(scope);
  }

  if (typeof provider.collect !== "function") {
    throw new ContextProviderConfigurationError(
      `ContextProvider ${provider.id} must provide a collect function`,
    );
  }
}

function requireSafeIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new ContextProviderConfigurationError(`${field} must be a string`);
  }
  if (
    input.length === 0 ||
    input.length > SAFE_IDENTIFIER_MAX_LENGTH ||
    containsControlCharacter(input)
  ) {
    throw new ContextProviderConfigurationError(`${field} must be a non-empty safe identifier`);
  }
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
