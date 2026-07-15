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

  it("秘密情報をエラー出力へ含めない", () => {
    const result = validateModelConfig(document([{ ...minimal[0], apiKey: "plain-secret-value" }]));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain("plain-secret-value");
    expect(result.issues[0]?.path).toBe("/providers/0/apiKey");
  });

  it("意味制約とworkspace制約を検証する", () => {
    const result = validateModelConfig(
      document([
        {
          ...minimal[0],
          apiKey: "secret://openai",
          models: [{ ...minimal[0].models[0], maxOutputTokens: 20000 }],
        },
      ]),
      "workspace",
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CONFIG_WORKSPACE_POLICY_VIOLATION", "CONFIG_SEMANTIC_INVALID"]),
    );
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
});
