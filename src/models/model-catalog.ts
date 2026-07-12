export interface ModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly available?: boolean;
}

export interface ModelCatalog {
  listAvailable(): readonly ModelCatalogEntry[];
  findAvailable(modelId: string): ModelCatalogEntry | undefined;
}

/**
 * Temporary catalog boundary for the UI milestone.
 * Model Configuration Loader will replace this source in the model-settings milestone.
 */
export class StaticModelCatalog implements ModelCatalog {
  private readonly entries: readonly ModelCatalogEntry[];

  public constructor(entries: readonly ModelCatalogEntry[] = DEFAULT_MODEL_CATALOG) {
    this.entries = deduplicateEntries(entries);
  }

  public listAvailable(): readonly ModelCatalogEntry[] {
    return this.entries.filter((entry) => entry.available !== false).sort(compareModelEntries);
  }

  public findAvailable(modelId: string): ModelCatalogEntry | undefined {
    return this.listAvailable().find((entry) => entry.id === modelId);
  }
}

export const DEFAULT_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "coding-primary",
    label: "Coding Primary",
    provider: "primary-openai",
  },
  {
    id: "coding-fast",
    label: "Coding Fast",
    provider: "primary-openai",
  },
];

function deduplicateEntries(entries: readonly ModelCatalogEntry[]): readonly ModelCatalogEntry[] {
  const unique = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.id) && isValidEntry(entry)) {
      unique.set(entry.id, entry);
    }
  }
  return [...unique.values()];
}

function isValidEntry(entry: ModelCatalogEntry): boolean {
  return entry.id.length > 0 && entry.label.trim().length > 0 && entry.provider.length > 0;
}

function compareModelEntries(left: ModelCatalogEntry, right: ModelCatalogEntry): number {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}
