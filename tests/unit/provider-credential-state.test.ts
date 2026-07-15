import { describe, expect, it } from "vitest";

import {
  INITIAL_PROVIDER_CREDENTIAL_STATE,
  getCredentialStatusLabel,
  providerCredentialReducer,
} from "../../src/ui/webview/provider-credential-state";

const provider = {
  providerId: "openai",
  displayName: "openai",
  vendor: "OpenAI",
  status: "configured" as const,
  canEdit: true,
};

describe("providerCredentialReducer", () => {
  it("登録状態を表示し、キー本体を状態へ持たない", () => {
    const state = providerCredentialReducer(INITIAL_PROVIDER_CREDENTIAL_STATE, {
      type: "credentials-updated",
      providers: [provider],
    });

    expect(state).toMatchObject({ phase: "ready", providers: [provider] });
    expect(JSON.stringify(state)).not.toContain("key");
  });

  it("操作中の二重操作を抑止し、結果通知を反映する", () => {
    const ready = providerCredentialReducer(INITIAL_PROVIDER_CREDENTIAL_STATE, {
      type: "credentials-updated",
      providers: [provider],
    });
    const updating = providerCredentialReducer(ready, {
      type: "operation-requested",
      providerId: "openai",
    });
    expect(
      providerCredentialReducer(updating, { type: "operation-requested", providerId: "openai" }),
    ).toBe(updating);

    const completed = providerCredentialReducer(updating, {
      type: "operation-result",
      providerId: "openai",
      status: "succeeded",
    });
    expect(completed.phase).toBe("ready");
    expect(completed.pendingProviderId).toBeUndefined();
  });

  it("状態ラベルを安全な固定文言へ変換する", () => {
    expect(getCredentialStatusLabel("configured")).toBe("設定済み");
    expect(getCredentialStatusLabel("not-configured")).toBe("未設定");
    expect(getCredentialStatusLabel("unavailable")).toBe("確認できません");
  });
});
