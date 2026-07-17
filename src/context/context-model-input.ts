import type { ContextCollectionResult } from "./context-provider";
import type { ContextItem, SerializedRange } from "./context-item";

export interface ModelContextItem {
  readonly id: string;
  readonly kind: ContextItem["kind"];
  readonly source: string;
  readonly content: string;
  readonly uri?: string;
  readonly range?: SerializedRange;
  readonly metadata?: ContextItem["metadata"];
  readonly estimatedTokens: number;
  readonly contentHash: string;
}

export interface ModelContextInput {
  readonly items: readonly ModelContextItem[];
  readonly estimatedTokens: number;
}

export interface ContextModelInputOptions {
  /** The usable token budget after model output and tool reservations. */
  readonly maxTokens?: number;
}

/**
 * Applies the ContextManager boundary before a model request is constructed.
 * Provider items remain immutable and are never exposed to the model until
 * they have passed ordering, deduplication, and budget selection.
 */
export class DefaultContextManager {
  public createModelInput(
    collection: ContextCollectionResult,
    options: ContextModelInputOptions = {},
  ): ModelContextInput {
    if (collection.status === "cancelled") {
      return { items: [], estimatedTokens: 0 };
    }

    const maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maxTokens) && maxTokens !== Number.POSITIVE_INFINITY) {
      throw new ContextModelInputConfigurationError("maxTokens must be finite or omitted");
    }
    if (maxTokens < 0) {
      throw new ContextModelInputConfigurationError("maxTokens must be non-negative");
    }

    const deduplicated = deduplicate(collection.items);
    const ordered = deduplicated
      .map((item, index) => ({ item, index }))
      .sort((left, right) => right.item.priority - left.item.priority || left.index - right.index);

    const items: ModelContextItem[] = [];
    let estimatedTokens = 0;
    for (const candidate of ordered) {
      const nextTokens = estimatedTokens + candidate.item.estimatedTokens;
      if (nextTokens > maxTokens) continue;
      items.push(toModelContextItem(candidate.item));
      estimatedTokens = nextTokens;
    }

    return { items, estimatedTokens };
  }
}

export class ContextModelInputConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextModelInputConfigurationError";
  }
}

function toModelContextItem(item: ContextItem): ModelContextItem {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    content: item.content,
    ...(item.uri === undefined ? {} : { uri: item.uri }),
    ...(item.range === undefined ? {} : { range: item.range }),
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    estimatedTokens: item.estimatedTokens,
    contentHash: item.contentHash,
  };
}

function deduplicate(items: readonly ContextItem[]): readonly ContextItem[] {
  const seen = new Set<string>();
  const result: ContextItem[] = [];
  for (const item of items) {
    const key = JSON.stringify({
      uri: item.uri ?? null,
      range: item.range ?? null,
      contentHash: item.contentHash,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
