import { existsSync, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  type ConfigScope,
  type ModelConfig,
  type ModelConfigValidationIssue,
  validateModelConfig,
} from "./model-config-validator";

export type ModelConfigSourceKind = "default" | "user-common" | "workspace" | "user-settings";

export interface ModelConfigSource {
  readonly kind: ModelConfigSourceKind;
  readonly path?: string;
  readonly value?: unknown;
}

export interface ModelConfigLoaderOptions {
  readonly defaultPath?: string;
  readonly userCommonPath?: string;
  readonly workspacePath?: string;
  readonly userSettings?: () => unknown;
  readonly includeBuiltinDefault?: boolean;
  readonly workspaceTrusted?: boolean | (() => boolean);
  readonly debounceMs?: number;
  readonly onDidChange?: (snapshot: ModelConfigSnapshot) => void;
  readonly onDiagnostic?: (diagnostic: ModelConfigDiagnostic) => void;
}

export interface ModelConfigSnapshot {
  readonly revision: number;
  readonly config: ModelConfig;
  readonly defaultModelId?: string;
  readonly sources: readonly ModelConfigSourceKind[];
}

export interface ModelConfigDiagnostic {
  readonly source: ModelConfigSourceKind;
  readonly path?: string;
  readonly issues: readonly ModelConfigValidationIssue[];
}

export interface Disposable {
  dispose(): void;
}

const SOURCE_ORDER: readonly ModelConfigSourceKind[] = [
  "default",
  "user-common",
  "workspace",
  "user-settings",
];

const DEFAULT_BUILTIN_PATH = resolve(__dirname, "../../resources/default-models.json");
const DEFAULT_FALLBACK_CONFIG = `{
  "providers": [
    {
      "name": "OpenAI",
      "vendor": "openai",
      "apiType": "responses",
      "models": [
        {
          "id": "coding-primary",
          "name": "Coding Primary",
          "url": "https://api.openai.com/v1/responses",
          "toolCalling": true,
          "streaming": true,
          "vision": true,
          "reasoning": false,
          "maxInputTokens": 128000,
          "maxOutputTokens": 16384
        }
      ]
    }
  ],
  "defaultModelId": "coding-primary"
}
`;

export function defaultUserCommonPath(): string {
  return join(homedir(), ".byok-agent", "models.json");
}

export class ModelConfigLoader {
  private readonly options: Required<Pick<ModelConfigLoaderOptions, "debounceMs">> &
    ModelConfigLoaderOptions;
  private readonly watchers: FSWatcher[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private revision = 0;
  private snapshot: ModelConfigSnapshot | undefined;

  public constructor(options: ModelConfigLoaderOptions = {}) {
    this.options = { debounceMs: 50, ...options };
  }

  public get current(): ModelConfigSnapshot | undefined {
    return this.snapshot;
  }

  public async ensureUserCommonConfig(): Promise<boolean> {
    this.assertActive();
    const path = this.options.userCommonPath ?? defaultUserCommonPath();
    try {
      await fs.access(path);
      return false;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    await fs.mkdir(dirname(path), { recursive: true });
    try {
      await fs.copyFile(this.options.defaultPath ?? DEFAULT_BUILTIN_PATH, path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      await fs.writeFile(path, DEFAULT_FALLBACK_CONFIG, { encoding: "utf8", flag: "wx" });
    }
    return true;
  }

  public async load(): Promise<ModelConfigSnapshot | undefined> {
    this.assertActive();
    const sources = await this.readSources();
    const merged: unknown[] = [];
    let defaultModelId: string | undefined;
    let invalidSourceFound = false;

    for (const source of sources) {
      if (source.value === undefined) continue;
      const sourceResult = this.validateSource(source);
      if (!sourceResult.valid) {
        this.report({ source: source.kind, path: source.path, issues: sourceResult.issues });
        invalidSourceFound = true;
        continue;
      }

      if (isRecord(source.value) && typeof source.value.defaultModelId === "string") {
        defaultModelId = source.value.defaultModelId;
      }

      if (source.kind === "workspace") {
        const policyIssues = this.workspacePolicyIssues(
          isRecord(source.value) ? source.value.providers : undefined,
          merged,
        );
        if (policyIssues.length > 0) {
          this.report({ source: source.kind, path: source.path, issues: policyIssues });
          invalidSourceFound = true;
          continue;
        }
      }

      merged.splice(
        0,
        merged.length,
        ...mergeProviderArrays(merged, isRecord(source.value) ? source.value.providers : undefined),
      );
    }

    const result = validateModelConfig({ providers: merged }, "default");
    if (!result.valid || !result.config) {
      const source = sources.at(-1);
      this.report({ source: source?.kind ?? "default", path: source?.path, issues: result.issues });
      return this.snapshot;
    }

    if (invalidSourceFound && this.snapshot) return this.snapshot;

    const next: ModelConfigSnapshot = {
      revision: ++this.revision,
      config: deepFreeze(result.config),
      ...(defaultModelId ? { defaultModelId } : {}),
      sources: sources.filter((source) => source.value !== undefined).map((source) => source.kind),
    };
    this.snapshot = next;
    this.options.onDidChange?.(next);
    return next;
  }

  public watch(): Disposable {
    this.assertActive();
    for (const path of [
      this.options.userCommonPath ?? defaultUserCommonPath(),
      this.options.workspacePath,
    ]) {
      if (!path) continue;
      try {
        const watchedDirectory = nearestExistingDirectory(dirname(path));
        const targetName = basename(path);
        this.watchers.push(
          watch(watchedDirectory, (_event, filename) => {
            if (!filename || filename.toString() === targetName) this.scheduleReload();
          }),
        );
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    return { dispose: () => this.stopWatching() };
  }

  public async refresh(): Promise<ModelConfigSnapshot | undefined> {
    return this.load();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.stopWatching();
  }

  private async readSources(): Promise<ModelConfigSource[]> {
    const configured: Record<ModelConfigSourceKind, ModelConfigSource> = {
      default: { kind: "default", path: this.options.defaultPath ?? DEFAULT_BUILTIN_PATH },
      "user-common": {
        kind: "user-common",
        path: this.options.userCommonPath ?? defaultUserCommonPath(),
      },
      workspace: { kind: "workspace", path: this.options.workspacePath },
      "user-settings": { kind: "user-settings", value: this.options.userSettings?.() },
    };
    const sources: ModelConfigSource[] = [];
    for (const kind of SOURCE_ORDER) {
      if (kind === "default" && this.options.includeBuiltinDefault === false) continue;
      const source = configured[kind];
      if (source.value !== undefined) {
        sources.push(source);
        continue;
      }
      if (!source.path) {
        sources.push(source);
        continue;
      }
      try {
        sources.push({ ...source, value: JSON.parse(await fs.readFile(source.path, "utf8")) });
      } catch (error) {
        if (isMissingFileError(error)) {
          sources.push({ ...source, value: undefined });
          continue;
        }
        const issue: ModelConfigValidationIssue = {
          code: "CONFIG_INVALID_JSON",
          path: "/",
          message:
            error instanceof SyntaxError
              ? "設定ファイルのJSON構文が不正です。"
              : "設定ファイルを読み込めません。",
        };
        this.report({ source: source.kind, path: source.path, issues: [issue] });
        return [];
      }
    }
    return this.isWorkspaceTrusted() === false
      ? sources.map((source) =>
          source.kind === "workspace" ? { ...source, value: undefined } : source,
        )
      : sources;
  }

  private validateSource(source: ModelConfigSource) {
    if (source.kind === "user-settings" && typeof source.value !== "object") {
      return validateModelConfig(source.value, "user-settings");
    }
    const result = validateModelConfig(source.value, source.kind as ConfigScope);
    if (result.valid) return result;
    // Source overlays may omit required fields; the complete merged value is validated below.
    const overlayIssues = validateOverlay(source.value);
    return overlayIssues.length === 0
      ? { valid: true, issues: [] as ModelConfigValidationIssue[] }
      : { valid: false, issues: overlayIssues };
  }

  private workspacePolicyIssues(
    value: unknown,
    lowerSources: unknown[],
  ): ModelConfigValidationIssue[] {
    if (this.isWorkspaceTrusted() === false) return [];
    const issues: ModelConfigValidationIssue[] = [];
    if (!Array.isArray(value)) return issues;
    const baseline = flattenModels([lowerSources]);
    value.forEach((provider, providerIndex) => {
      if (!isRecord(provider)) return;
      if ("apiKey" in provider) {
        issues.push({
          code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
          path: `/${providerIndex}/apiKey`,
          message: "ワークスペース設定からSecret参照を変更できません。",
        });
      }
      if ("headers" in provider) {
        const headers = provider.headers;
        if (isRecord(headers)) {
          for (const headerName of Object.keys(headers)) {
            issues.push({
              code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
              path: `/${providerIndex}/headers/${escapeJsonPointer(headerName)}`,
              message: "ワークスペース設定から任意HTTPヘッダーを追加・変更できません。",
            });
          }
        }
      }
      const models = provider.models;
      if (!Array.isArray(models)) return;
      models.forEach((model, modelIndex) => {
        if (!isRecord(model) || typeof model.id !== "string") return;
        const previous = baseline.get(`${String(provider.name)}\u0000${model.id}`);
        if (!previous || ("url" in model && model.url !== previous.url)) {
          issues.push({
            code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
            path: `/${providerIndex}/models/${modelIndex}/url`,
            message: "ワークスペース設定からProvider URLを追加・変更できません。",
          });
        }
      });
    });
    return issues;
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.load();
    }, this.options.debounceMs);
  }

  private stopWatching(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private report(diagnostic: ModelConfigDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }

  private isWorkspaceTrusted(): boolean {
    const value = this.options.workspaceTrusted;
    return typeof value === "function" ? value() : (value ?? true);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ModelConfigLoader has been disposed");
  }
}

function mergeProviderArrays(base: unknown[], overlay: unknown): unknown[] {
  if (!Array.isArray(overlay)) return base;
  const result = base.map((item) => clone(item));
  for (const provider of overlay) {
    if (!isRecord(provider) || typeof provider.name !== "string") {
      result.push(clone(provider));
      continue;
    }
    const index = result.findIndex((item) => isRecord(item) && item.name === provider.name);
    if (index < 0) result.push(clone(provider));
    else result[index] = mergeProvider(result[index], provider);
  }
  return result;
}

function mergeProvider(base: unknown, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = isRecord(base) ? (clone(base) as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      key === "models" ? mergeModels(result.models, value) : mergeValue(result[key], value);
  }
  return result;
}

function mergeModels(base: unknown, overlay: unknown): unknown[] {
  const result = Array.isArray(base) ? base.map((item) => clone(item)) : [];
  if (!Array.isArray(overlay)) return result;
  for (const model of overlay) {
    if (!isRecord(model) || typeof model.id !== "string") {
      result.push(clone(model));
      continue;
    }
    const index = result.findIndex((item) => isRecord(item) && item.id === model.id);
    if (index < 0) result.push(clone(model));
    else result[index] = mergeValue(result[index], model);
  }
  return result;
}

function mergeValue(base: unknown, overlay: unknown): unknown {
  if (isRecord(base) && isRecord(overlay)) {
    const result = clone(base) as Record<string, unknown>;
    for (const [key, value] of Object.entries(overlay))
      result[key] = mergeValue(result[key], value);
    return result;
  }
  return clone(overlay);
}

function validateOverlay(value: unknown): ModelConfigValidationIssue[] {
  const providers = isRecord(value) ? value.providers : undefined;
  if (!Array.isArray(providers) || providers.length === 0) {
    return [
      {
        code: "CONFIG_SCHEMA_INVALID",
        path: "/providers",
        message: "設定ソースはproviders配列を持つオブジェクトでなければなりません。",
      },
    ];
  }
  return [];
}

function flattenModels(sources: unknown[]): Map<string, { url: unknown }> {
  const map = new Map<string, { url: unknown }>();
  let merged: unknown[] = [];
  for (const source of sources) merged = mergeProviderArrays(merged, source);
  for (const provider of merged) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (isRecord(model) && typeof provider.name === "string" && typeof model.id === "string") {
        map.set(`${provider.name}\u0000${model.id}`, { url: model.url });
      }
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function clone<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function nearestExistingDirectory(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
