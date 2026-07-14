import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(join(__dirname, "../../resources/model-config.schema.json"), "utf8"),
) as object;

export type ApiType = "chat-completions" | "responses" | "messages";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ConfigScope = "user-settings" | "user-common" | "workspace" | "default";

export interface AgentSettings {
  promptProfile?: string;
  contextProfile?: "compact" | "balanced" | "extended";
  toolProfile?: "read-only" | "workspace" | "full";
  maxIterations?: number;
  maxToolCalls?: number;
  maxConsecutiveFailures?: number;
}

export interface ModelConfigModel {
  id: string;
  name: string;
  vendor?: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: ReasoningEffort[];
  maxInputTokens: number;
  maxOutputTokens: number;
  agent?: AgentSettings;
}

export interface ModelConfigProvider {
  name: string;
  vendor: string;
  apiKey?: string;
  apiType: ApiType;
  models: ModelConfigModel[];
}

export type ModelConfig = ModelConfigProvider[];

export type ModelConfigIssueCode =
  | "CONFIG_INVALID_JSON"
  | "CONFIG_SCHEMA_INVALID"
  | "CONFIG_UNKNOWN_PROPERTY"
  | "CONFIG_INVALID_REFERENCE"
  | "CONFIG_SEMANTIC_INVALID"
  | "CONFIG_WORKSPACE_POLICY_VIOLATION";

export interface ModelConfigValidationIssue {
  code: ModelConfigIssueCode;
  path: string;
  keyword?: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ModelConfigValidationResult {
  valid: boolean;
  config?: ModelConfig;
  issues: ModelConfigValidationIssue[];
}

const SENSITIVE_PATH = /(?:apiKey|authorization|cookie|token|secret|password|header)/i;

function jsonPointer(path: string, property?: string): string {
  const suffix =
    property === undefined ? "" : `/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  if (path === "/") return suffix || "/";
  return path || suffix ? `${path || ""}${suffix}` : "/";
}

function safeActual(value: unknown, path: string): string | undefined {
  if (SENSITIVE_PATH.test(path)) return "[REDACTED]";
  if (value === undefined) return undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : "object";
}

function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

function isProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname || url.pathname.includes("..")) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLocalhost(url.hostname));
  } catch {
    return false;
  }
}

function valueAtPointer(value: unknown, path: string): unknown {
  if (path === "/") return value;
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => {
      if (current !== null && typeof current === "object") {
        return (current as Record<string, unknown>)[part];
      }
      return undefined;
    }, value);
}

function issueFromAjv(error: ErrorObject, value: unknown): ModelConfigValidationIssue {
  const path = error.instancePath;
  const params = error.params as Record<string, unknown>;
  const property =
    typeof params.additionalProperty === "string" ? params.additionalProperty : undefined;
  const issuePath = jsonPointer(path, property);
  const sensitive = SENSITIVE_PATH.test(issuePath);
  const expected =
    error.keyword === "type"
      ? String(params.type)
      : error.keyword === "enum"
        ? "allowed enum value"
        : undefined;
  return {
    code:
      error.keyword === "additionalProperties"
        ? "CONFIG_UNKNOWN_PROPERTY"
        : error.keyword === "pattern" && issuePath.endsWith("/apiKey")
          ? "CONFIG_INVALID_REFERENCE"
          : "CONFIG_SCHEMA_INVALID",
    path: issuePath,
    keyword: error.keyword,
    message: sensitive
      ? "設定値がSchemaに適合しません。"
      : (error.message ?? "設定値がSchemaに適合しません。"),
    expected,
    actual: safeActual(valueAtPointer(value, issuePath), issuePath),
  };
}

function semanticIssues(config: ModelConfig): ModelConfigValidationIssue[] {
  const issues: ModelConfigValidationIssue[] = [];
  const providerNames = new Set<string>();
  const modelIds = new Set<string>();
  config.forEach((provider, providerIndex) => {
    if (providerNames.has(provider.name)) {
      issues.push({
        code: "CONFIG_SEMANTIC_INVALID",
        path: `/${providerIndex}/name`,
        message: "Provider名が重複しています。",
        expected: "unique provider name",
        actual: provider.name,
      });
    }
    providerNames.add(provider.name);
    provider.models.forEach((model, modelIndex) => {
      const path = `/${providerIndex}/models/${modelIndex}`;
      if (modelIds.has(model.id)) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/id`,
          message: "Model IDが重複しています。",
          expected: "unique model id",
          actual: model.id,
        });
      }
      modelIds.add(model.id);
      if (model.maxOutputTokens > model.maxInputTokens) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/maxOutputTokens`,
          message: "maxOutputTokensはmaxInputTokens以下でなければなりません。",
          expected: "<= maxInputTokens",
          actual: String(model.maxOutputTokens),
        });
      }
      if (model.supportsReasoningEffort !== undefined && model.thinking !== true) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/supportsReasoningEffort`,
          message: "thinkingがtrueの場合だけreasoning effortを指定できます。",
          expected: "thinking=true",
          actual: "thinking is not true",
        });
      }
    });
  });
  return issues;
}

function workspaceIssues(config: ModelConfig): ModelConfigValidationIssue[] {
  const issues: ModelConfigValidationIssue[] = [];
  config.forEach((provider, providerIndex) => {
    if (provider.apiKey !== undefined) {
      issues.push({
        code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
        path: `/${providerIndex}/apiKey`,
        message: "ワークスペース設定からSecret参照を変更できません。",
      });
    }
    provider.models.forEach((model, modelIndex) => {
      issues.push({
        code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
        path: `/${providerIndex}/models/${modelIndex}/url`,
        message: "ワークスペース設定からProvider URLを変更できません。",
      });
    });
  });
  return issues;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("provider-url", { type: "string", validate: isProviderUrl });
const validate: ValidateFunction = ajv.compile(schema);

export function parseAndValidateModelConfig(
  json: string,
  scope: ConfigScope = "default",
): ModelConfigValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return {
      valid: false,
      issues: [
        {
          code: "CONFIG_INVALID_JSON",
          path: "/",
          message: "設定ファイルは有効なUTF-8 JSONではありません。",
        },
      ],
    };
  }
  return validateModelConfig(value, scope);
}

export function validateModelConfig(
  value: unknown,
  scope: ConfigScope = "default",
): ModelConfigValidationResult {
  if (!validate(value)) {
    const issues = (validate.errors ?? []).map((error) => issueFromAjv(error, value));
    return { valid: false, issues };
  }
  const config = value as ModelConfig;
  const issues = [
    ...semanticIssues(config),
    ...(scope === "workspace" ? workspaceIssues(config) : []),
  ];
  return issues.length > 0 ? { valid: false, issues } : { valid: true, config, issues: [] };
}

export { schema as modelConfigSchema };
