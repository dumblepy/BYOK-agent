import type { SecretStorage } from "vscode";

const SECRET_PREFIX = "byokAgent.secret.v1.apiKey.";

export class SecretStoreError extends Error {
  public override readonly name = "SecretStoreError";

  public constructor(message: string) {
    super(message);
  }
}

export function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    hasForbiddenProviderIdCharacter(normalized)
  ) {
    throw new SecretStoreError("Provider IDが不正です。");
  }
  return normalized;
}

function hasForbiddenProviderIdCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === "\\" || character === "/";
  });
}

export function secretStorageKey(providerId: string): string {
  return `${SECRET_PREFIX}${encodeURIComponent(normalizeProviderId(providerId))}`;
}

export interface SecretStore {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

/** Stores provider credentials exclusively in VS Code SecretStorage. */
export class ExtensionSecretStore implements SecretStore {
  public constructor(private readonly secrets: SecretStorage) {}

  public async get(providerId: string): Promise<string | undefined> {
    try {
      return await this.secrets.get(secretStorageKey(providerId));
    } catch {
      throw new SecretStoreError("APIキーを取得できませんでした。");
    }
  }

  public async set(providerId: string, value: string): Promise<void> {
    if (value.trim().length === 0) {
      throw new SecretStoreError("APIキーは空にできません。");
    }

    try {
      await this.secrets.store(secretStorageKey(providerId), value);
    } catch {
      throw new SecretStoreError("APIキーを保存できませんでした。");
    }
  }

  public async delete(providerId: string): Promise<void> {
    try {
      await this.secrets.delete(secretStorageKey(providerId));
    } catch {
      throw new SecretStoreError("APIキーを削除できませんでした。");
    }
  }
}
