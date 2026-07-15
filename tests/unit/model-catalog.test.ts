import { describe, expect, it } from "vitest";

import { ConfiguredModelCatalog } from "../../src/models/model-catalog";
import type { ModelConfig } from "../../src/models/model-config-validator";

const config: ModelConfig = [
  {
    name: "OpenAI",
    vendor: "openai",
    apiType: "responses",
    apiKey: "secret://openai",
    headers: { "X-Client-Version": "1" },
    models: [
      {
        id: "logical-coding",
        name: "Coding",
        url: "https://api.openai.com/v1/responses",
        toolCalling: true,
        vision: true,
        thinking: true,
        supportsReasoningEffort: ["high"],
        maxInputTokens: 128000,
        maxOutputTokens: 16000,
        agent: { maxIterations: 8, toolProfile: "workspace" },
      },
    ],
  },
];

describe("ConfiguredModelCatalog", () => {
  it("モデルIDからProvider設定と能力を解決する", () => {
    const catalog = new ConfiguredModelCatalog(config, { hasSecret: () => true });
    const model = catalog.resolve("logical-coding");

    expect(model).toMatchObject({
      id: "logical-coding",
      provider: {
        id: "OpenAI",
        apiType: "responses",
        url: "https://api.openai.com/v1/responses",
        secretRef: "secret://openai",
      },
      capabilities: { toolCalling: true, vision: true, thinking: true },
      agent: { maxIterations: 8, toolProfile: "workspace" },
    });
    expect(model?.provider.headers).toEqual({ "X-Client-Version": "1" });
  });

  it("Secretが利用できないモデルを一覧と既定値から除外する", () => {
    const catalog = new ConfiguredModelCatalog(config, { hasSecret: () => false });

    expect(catalog.listAvailable()).toHaveLength(0);
    expect(catalog.getDefault()).toBeUndefined();
    expect(catalog.diagnostics()).toContainEqual(
      expect.objectContaining({ code: "MODEL_SECRET_UNAVAILABLE" }),
    );
  });

  it("明示した既定モデルを優先し、無効な既定値は自動補正しない", () => {
    const catalog = new ConfiguredModelCatalog(config, {
      defaultModelId: "missing-model",
      hasSecret: () => true,
    });

    expect(catalog.getDefault()).toBeUndefined();
    expect(catalog.diagnostics()).toContainEqual(
      expect.objectContaining({ code: "MODEL_DEFAULT_INVALID" }),
    );
  });

  it("重複IDを実行可能一覧へ含めない", () => {
    const duplicate = [...config, { ...config[0], models: [{ ...config[0].models[0] }] }];
    const catalog = new ConfiguredModelCatalog(duplicate, { hasSecret: () => true });

    expect(catalog.listAvailable()).toHaveLength(1);
    expect(catalog.diagnostics()).toContainEqual(
      expect.objectContaining({ code: "MODEL_DUPLICATE_ID" }),
    );
  });
});
