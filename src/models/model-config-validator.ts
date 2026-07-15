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
  streaming?: boolean;
  vision: boolean;
  reasoning?: boolean;
  reasoningEfforts?: readonly ReasoningEffort[];
  /** @deprecated Use reasoning. Kept only for reading existing config files. */
  thinking?: boolean;
  /** @deprecated Use reasoningEfforts. Kept only for reading existing config files. */
  supportsReasoningEffort?: readonly ReasoningEffort[];
  maxInputTokens: number;
  maxOutputTokens: number;
  agent?: AgentSettings;
}

export interface ModelConfigProvider {
  name: string;
  vendor: string;
  /** @deprecated Ignored for compatibility. API keys belong in SecretStorage. */
  apiKey?: unknown;
  apiType: ApiType;
  headers?: Record<string, string>;
  models: ModelConfigModel[];
}

export type ModelConfig = ModelConfigProvider[];

export interface ModelConfigDocument {
  readonly providers: ModelConfigProvider[];
  readonly defaultModelId?: string;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  reasoning: boolean;
  reasoningEfforts: readonly ReasoningEffort[];
  /** @deprecated Runtime code must use reasoning. */
  thinking?: boolean;
  /** @deprecated Runtime code must use reasoningEfforts. */
  supportsReasoningEffort?: readonly ReasoningEffort[];
}

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

const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
  "origin",
  "referer",
  "forwarded",
  "via",
]);

function headerNameIssue(name: string): string | undefined {
  const normalized = name.toLowerCase();
  if (FORBIDDEN_HEADER_NAMES.has(normalized) || normalized.startsWith("proxy-")) {
    return "認証・転送・接続を制御するHTTPヘッダーは上書きできません。";
  }
  if (normalized.startsWith("x-forwarded-")) {
    return "転送元を示すHTTPヘッダーは上書きできません。";
  }
  if (name !== name.trim()) return "HTTPヘッダー名の前後空白は許可されません。";
  if (hasHeaderControlCharacter(name)) {
    return "HTTPヘッダー名に制御文字を含めることはできません。";
  }
  return undefined;
}

function headerIssues(headers: Record<string, string>, basePath: string) {
  const issues: ModelConfigValidationIssue[] = [];
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const path = `${basePath}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const nameIssue = headerNameIssue(name);
    if (nameIssue) {
      issues.push({
        code: "CONFIG_SEMANTIC_INVALID",
        path,
        message: nameIssue,
      });
    }
    const normalized = name.trim().toLowerCase();
    if (normalizedNames.has(normalized)) {
      issues.push({
        code: "CONFIG_SEMANTIC_INVALID",
        path,
        message: "大文字小文字を無視したHTTPヘッダー名の重複は許可されません。",
      });
    }
    normalizedNames.add(normalized);
    if (hasHeaderControlCharacter(value)) {
      issues.push({
        code: "CONFIG_SEMANTIC_INVALID",
        path,
        message: "HTTPヘッダー値に改行または制御文字を含めることはできません。",
      });
    }
  }
  return issues;
}

function hasHeaderControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
        path: `/providers/${providerIndex}/name`,
        message: "Provider名が重複しています。",
        expected: "unique provider name",
        actual: provider.name,
      });
    }
    providerNames.add(provider.name);
    if (provider.headers !== undefined) {
      issues.push(...headerIssues(provider.headers, `/providers/${providerIndex}/headers`));
    }
    provider.models.forEach((model, modelIndex) => {
      const path = `/providers/${providerIndex}/models/${modelIndex}`;
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
      const reasoning = model.reasoning ?? model.thinking ?? false;
      const reasoningEfforts = model.reasoningEfforts ?? model.supportsReasoningEffort;
      if (reasoningEfforts !== undefined && reasoning !== true) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/${model.reasoningEfforts !== undefined ? "reasoningEfforts" : "supportsReasoningEffort"}`,
          message: "reasoningがtrueの場合だけreasoning effortを指定できます。",
          expected: "reasoning=true",
          actual: "reasoning is not true",
        });
      }
      if (
        model.reasoning !== undefined &&
        model.thinking !== undefined &&
        model.reasoning !== model.thinking
      ) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/reasoning`,
          message: "reasoningと旧thinkingの値を一致させてください。",
        });
      }
      if (
        model.reasoningEfforts !== undefined &&
        model.supportsReasoningEffort !== undefined &&
        JSON.stringify(model.reasoningEfforts) !== JSON.stringify(model.supportsReasoningEffort)
      ) {
        issues.push({
          code: "CONFIG_SEMANTIC_INVALID",
          path: `${path}/reasoningEfforts`,
          message: "reasoningEffortsと旧supportsReasoningEffortの値を一致させてください。",
        });
      }
    });
  });
  return issues;
}

function workspaceIssues(config: ModelConfig): ModelConfigValidationIssue[] {
  const issues: ModelConfigValidationIssue[] = [];
  config.forEach((provider, providerIndex) => {
    provider.models.forEach((model, modelIndex) => {
      issues.push({
        code: "CONFIG_WORKSPACE_POLICY_VIOLATION",
        path: `/providers/${providerIndex}/models/${modelIndex}/url`,
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
  const config = (value as ModelConfigDocument).providers.map(
    ({ apiKey: _ignored, ...provider }) => {
      void _ignored;
      return provider;
    },
  );
  const issues = [
    ...semanticIssues(config),
    ...(scope === "workspace" ? workspaceIssues(config) : []),
  ];
  return issues.length > 0 ? { valid: false, issues } : { valid: true, config, issues: [] };
}

export { schema as modelConfigSchema };
