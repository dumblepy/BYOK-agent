import { describe, expect, it, vi } from "vitest";
import type { SecretStorage } from "vscode";

import {
  ExtensionSecretStore,
  SecretStoreError,
  normalizeProviderId,
  secretStorageKey,
} from "../../src/providers/secret-store";

function createSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    secrets: {
      get: vi.fn((key: string) => Promise.resolve(values.get(key))),
      store: vi.fn((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
    } as SecretStorage,
  };
}

describe("ExtensionSecretStore", () => {
  it("ProviderごとにSecretStorageへ保存・取得・削除する", async () => {
    const fake = createSecrets();
    const store = new ExtensionSecretStore(fake.secrets);

    await store.set("OpenAI", "secret-a");
    await store.set("OpenAI Compatible", "secret-compatible");
    await store.set("anthropic", "secret-b");

    await expect(store.get("openai")).resolves.toBe("secret-a");
    await expect(store.get("openai compatible")).resolves.toBe("secret-compatible");
    await expect(store.get("anthropic")).resolves.toBe("secret-b");
    expect(fake.values).toEqual(
      new Map([
        ["byokAgent.secret.v1.apiKey.openai", "secret-a"],
        ["byokAgent.secret.v1.apiKey.openai%20compatible", "secret-compatible"],
        ["byokAgent.secret.v1.apiKey.anthropic", "secret-b"],
      ]),
    );

    await store.delete("OpenAI");
    await expect(store.get("openai")).resolves.toBeUndefined();
    await expect(store.get("anthropic")).resolves.toBe("secret-b");
  });

  it("空文字と不正なProvider IDを拒否する", async () => {
    const store = new ExtensionSecretStore(createSecrets().secrets);

    await expect(store.set("openai", " \n")).rejects.toBeInstanceOf(SecretStoreError);
    expect(normalizeProviderId("Provider With Space")).toBe("provider with space");
    expect(() => secretStorageKey("../escape")).toThrow(SecretStoreError);
  });

  it("SecretStorageのエラーを秘密値なしのエラーへ変換する", async () => {
    const secrets = {
      get: vi.fn().mockRejectedValue(new Error("contains-secret")),
      store: vi.fn().mockRejectedValue(new Error("contains-secret")),
      delete: vi.fn().mockRejectedValue(new Error("contains-secret")),
    } as SecretStorage;
    const store = new ExtensionSecretStore(secrets);

    await expect(store.get("openai")).rejects.toThrow("APIキーを取得できませんでした。");
    await expect(store.set("openai", "secret-value")).rejects.toThrow(
      "APIキーを保存できませんでした。",
    );
    await expect(store.delete("openai")).rejects.toThrow("APIキーを削除できませんでした。");
    await expect(store.get("openai")).rejects.not.toThrow("contains-secret");
  });
});
