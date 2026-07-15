import { describe, expect, it } from "vitest";
import {
  parseAndValidateModelConfig,
  validateModelConfig,
} from "../../src/models/model-config-validator";

const minimal = [
  {
    name: "OpenAI",
    vendor: "openai",
    apiType: "responses",
    models: [
      {
        id: "gpt-5",
        name: "GPT 5",
        url: "https://api.openai.com/v1/responses",
        toolCalling: true,
        vision: true,
        maxInputTokens: 10000,
        maxOutputTokens: 2000,
      },
    ],
  },
];
const document = (providers: unknown) => ({ providers });

describe("model config validator", () => {
  it("最小の有効設定を受理する", () => {
    const result = validateModelConfig(document(minimal));
    expect(result.valid).toBe(true);
    expect(result.config?.[0]?.models[0]?.id).toBe("gpt-5");
  });

  it("生成されるドキュメント形式のprovidersを受理する", () => {
    const result = validateModelConfig({ providers: minimal, defaultModelId: "gpt-5" });
    expect(result.valid).toBe(true);
    expect(result.config?.[0]?.models[0]?.id).toBe("gpt-5");
  });

  it("Open Routerのモデル設定を受理する", () => {
    const result = validateModelConfig({
      providers: [
        {
          name: "Open Router",
          vendor: "openrouter",
          apiType: "responses",
          models: [
            {
              id: "gpt-5.4-nano",
              name: "GPT-5.4 Nano(0.16)",
              url: "https://openrouter.ai/api/v1/chat/completions",
              toolCalling: true,
              vision: false,
              thinking: true,
              supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
              maxInputTokens: 400000,
              maxOutputTokens: 128000,
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.config).toHaveLength(1);
    expect(result.config?.[0]?.models).toHaveLength(1);
  });

  it("JSON構文エラーを構造化して返す", () => {
    const result = parseAndValidateModelConfig("{");
    expect(result.issues[0]).toMatchObject({ code: "CONFIG_INVALID_JSON", path: "/" });
  });

  it("未知プロパティをパス付きで拒否する", () => {
    const result = validateModelConfig(document([{ ...minimal[0], unexpected: true }]));
    expect(result.issues[0]).toMatchObject({
      code: "CONFIG_UNKNOWN_PROPERTY",
      path: "/providers/0/unexpected",
    });
  });

  it("互換性のためapiKey項目を無視し、設定結果へ残さない", () => {
    const result = validateModelConfig(document([{ ...minimal[0], apiKey: "plain-secret-value" }]));
    expect(result.valid).toBe(true);
    expect(result.config?.[0]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(result.config)).not.toContain("plain-secret-value");
  });

  it("意味制約とworkspace制約を検証する", () => {
    const result = validateModelConfig(
      document([
        {
          ...minimal[0],
          models: [{ ...minimal[0].models[0], maxOutputTokens: 20000 }],
        },
      ]),
      "workspace",
    );
    expect(result.issues.map((issue) => issue.code)).toContain("CONFIG_SEMANTIC_INVALID");
  });

  it("HTTPはlocalhostだけを許可し、reasoningの関係を検証する", () => {
    const invalidUrl = validateModelConfig(
      document([
        {
          ...minimal[0],
          models: [
            {
              ...minimal[0].models[0],
              url: "http://example.com/api",
            },
          ],
        },
      ]),
    );
    expect(invalidUrl.issues.map((issue) => issue.path)).toContain("/providers/0/models/0/url");

    const invalidReasoning = validateModelConfig(
      document([
        {
          ...minimal[0],
          models: [
            {
              ...minimal[0].models[0],
              url: "http://localhost:8080/api",
              supportsReasoningEffort: ["low"],
            },
          ],
        },
      ]),
    );
    expect(invalidReasoning.issues.map((issue) => issue.path)).toContain(
      "/providers/0/models/0/supportsReasoningEffort",
    );
  });

  it("安全な追加ヘッダーだけを受理し、予約ヘッダーと改行を拒否する", () => {
    const valid = validateModelConfig(
      document([{ ...minimal[0], headers: { "X-Client-Version": "1" } }]),
    );
    expect(valid.valid).toBe(true);

    const invalid = validateModelConfig(
      document([
        {
          ...minimal[0],
          headers: {
            Authorization: "secret-value",
            "X-Forwarded-For": "127.0.0.1",
            "X-Trace": "ok\r\nInjected: yes",
          },
        },
      ]),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "/providers/0/headers/Authorization",
        "/providers/0/headers/X-Forwarded-For",
        "/providers/0/headers/X-Trace",
      ]),
    );
    expect(JSON.stringify(invalid.issues)).not.toContain("secret-value");
  });

  it("大文字小文字を無視したヘッダー重複を拒否する", () => {
    const result = validateModelConfig(
      document([
        {
          ...minimal[0],
          headers: { "X-Trace": "one", "x-trace": "two" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "大文字小文字を無視したHTTPヘッダー名の重複は許可されません。",
    );
  });

  it("新しいReasoning設定を検証し、旧形式との矛盾を拒否する", () => {
    const valid = validateModelConfig(
      document([
        {
          ...minimal[0],
          models: [
            {
              ...minimal[0].models[0],
              streaming: true,
              reasoning: true,
              reasoningEfforts: ["low", "high"],
            },
          ],
        },
      ]),
    );
    expect(valid.valid).toBe(true);

    const invalid = validateModelConfig(
      document([
        {
          ...minimal[0],
          models: [
            {
              ...minimal[0].models[0],
              reasoning: false,
              reasoningEfforts: ["low"],
            },
          ],
        },
      ]),
    );
    expect(invalid.issues.map((issue) => issue.path)).toContain(
      "/providers/0/models/0/reasoningEfforts",
    );
  });
});
