import { describe, expect, it, vi } from "vitest";

import { ConfiguredModelCatalog } from "../../src/models/model-catalog";
import type { ModelConfig } from "../../src/models/model-config-validator";

const config: ModelConfig = [
  {
    name: "OpenAI",
    vendor: "openai",
    apiType: "responses",
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
  it("Open Router設定のモデルを利用可能一覧へ含める", () => {
    const catalog = new ConfiguredModelCatalog([
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
    ]);

    expect(catalog.listAvailable().map((model) => model.id)).toEqual(["gpt-5.4-nano"]);
  });

  it("モデルIDからProvider設定と能力を解決する", () => {
    const catalog = new ConfiguredModelCatalog(config);
    const model = catalog.resolve("logical-coding");

    expect(model).toMatchObject({
      id: "logical-coding",
      provider: {
        id: "OpenAI",
        apiType: "responses",
        url: "https://api.openai.com/v1/responses",
      },
      capabilities: { toolCalling: true, vision: true, thinking: true },
      agent: { maxIterations: 8, toolProfile: "workspace" },
    });
    expect(model?.provider.headers).toEqual({ "X-Client-Version": "1" });
  });

  it("明示した既定モデルを優先し、無効な既定値は自動補正しない", () => {
    const catalog = new ConfiguredModelCatalog(config, {
      defaultModelId: "missing-model",
    });

    expect(catalog.getDefault()).toBeUndefined();
    expect(catalog.diagnostics()).toContainEqual(
      expect.objectContaining({ code: "MODEL_DEFAULT_INVALID" }),
    );
  });

  it("重複IDを実行可能一覧へ含めない", () => {
    const duplicate = [...config, { ...config[0], models: [{ ...config[0].models[0] }] }];
    const catalog = new ConfiguredModelCatalog(duplicate);

    expect(catalog.listAvailable()).toHaveLength(1);
    expect(catalog.diagnostics()).toContainEqual(
      expect.objectContaining({ code: "MODEL_DUPLICATE_ID" }),
    );
  });

  it("明示されたCapabilitiesを正規形へ変換し、モデル名を参照しない", () => {
    const configured = {
      ...config[0].models[0],
      id: "model-without-name-hint",
      name: "vision-disabled-model",
      toolCalling: false,
      streaming: true,
      vision: false,
      reasoning: true,
      reasoningEfforts: ["low", "high"] as const,
      thinking: undefined,
      supportsReasoningEffort: undefined,
    };
    const catalog = new ConfiguredModelCatalog([{ ...config[0], models: [configured] }], {
      hasSecret: () => true,
    });

    expect(catalog.resolve(configured.id)?.effectiveCapabilities).toMatchObject({
      toolCalling: false,
      streaming: true,
      vision: false,
      reasoning: true,
      reasoningEfforts: ["low", "high"],
    });
  });

  it("Adapterが非対応の能力を実効値で無効化する", () => {
    const catalog = new ConfiguredModelCatalog(config, {
      hasSecret: () => true,
      adapterCapabilities: { toolCalling: false, streaming: false },
    });

    expect(catalog.resolve("logical-coding")?.effectiveCapabilities).toMatchObject({
      toolCalling: false,
      streaming: false,
      vision: true,
      reasoning: true,
    });
  });

  it("設定の置換を購読者へ即時通知する", () => {
    const catalog = new ConfiguredModelCatalog(config, { hasSecret: () => true });
    const listener = vi.fn();
    const subscription = catalog.onDidChange(listener);

    catalog.replace(config, "logical-coding");

    expect(listener).toHaveBeenCalledTimes(1);
    subscription.dispose();
    catalog.replace(config);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
