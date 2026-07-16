import type { ArtifactKind, ArtifactRef } from "../storage/artifact-store";

export interface ToolResultArtifactStore {
  create(
    input: {
      readonly threadId: string;
      readonly kind: ArtifactKind;
      readonly mediaType: string;
      readonly encoding: "utf-8" | "binary";
      readonly content: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<ArtifactRef>;
}

export interface ToolResultArtifactInput {
  readonly threadId: string;
  readonly kind: Extract<ArtifactKind, "tool-result" | "command-output">;
  readonly output: string | Uint8Array;
  readonly mediaType?: string;
  readonly summary?: string;
  readonly inlineLimitChars?: number;
  readonly allowBinary?: boolean;
}

export interface ToolResultArtifactResult {
  readonly text: string;
  readonly summary: string;
  readonly artifactRef?: ArtifactRef;
  readonly byteLength: number;
  readonly redacted: boolean;
  readonly binary: boolean;
}

const DEFAULT_INLINE_LIMIT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 4_000;
const ANSI_PATTERN = new RegExp(
  `[${String.fromCharCode(0x1b, 0x9b)}][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?${String.fromCharCode(0x07)}|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-T-Zcf-nq-uy=><~]))`,
  "g",
);
const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\b(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret)[ \t]*[:=][ \t]*[^\s,;]+/gi,
  /-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/g,
];

export async function prepareToolResult(
  input: ToolResultArtifactInput,
  store: ToolResultArtifactStore,
  signal?: AbortSignal,
): Promise<ToolResultArtifactResult> {
  const normalized = normalizeOutput(input.output);
  const limit = input.inlineLimitChars ?? DEFAULT_INLINE_LIMIT_CHARS;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("inlineLimitChars must be a positive integer");
  }

  if (normalized.binary && !input.allowBinary) {
    return {
      text: "[バイナリ出力は安全上の理由で保存・表示できません。]",
      summary: sanitizeSummary(input.summary ?? "バイナリ出力は保存されませんでした。"),
      byteLength: normalized.bytes.byteLength,
      redacted: normalized.redacted,
      binary: true,
    };
  }

  const text = normalized.binary ? "[バイナリ出力]" : normalized.text;
  if (!normalized.binary && text.length <= limit) {
    return {
      text,
      summary: sanitizeSummary(input.summary ?? summarizeText(text)),
      byteLength: normalized.bytes.byteLength,
      redacted: normalized.redacted,
      binary: false,
    };
  }

  const artifactRef = await store.create(
    {
      threadId: input.threadId,
      kind: input.kind,
      mediaType: input.mediaType ?? (normalized.binary ? "application/octet-stream" : "text/plain"),
      encoding: normalized.binary ? "binary" : "utf-8",
      content: normalized.bytes,
    },
    signal,
  );
  const excerpt = normalized.binary ? "[バイナリ出力]" : compactExcerpt(text, limit);
  const summary = sanitizeSummary(
    [
      input.summary ?? summarizeText(text),
      `完全な出力: ${artifactRef.uri}`,
      `サイズ: ${normalized.bytes.byteLength} bytes`,
      `抜粋:\n${excerpt}`,
    ].join("\n"),
  );
  return {
    text: summary,
    summary,
    artifactRef,
    byteLength: normalized.bytes.byteLength,
    redacted: normalized.redacted,
    binary: normalized.binary,
  };
}

function normalizeOutput(output: string | Uint8Array): {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly binary: boolean;
  readonly redacted: boolean;
} {
  if (output instanceof Uint8Array) {
    const binary = isBinary(output);
    if (binary) return { text: "", bytes: output.slice(), binary: true, redacted: false };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(output);
    const sanitized = sanitizeText(text);
    return {
      text: sanitized.text,
      bytes: new TextEncoder().encode(sanitized.text),
      binary: false,
      redacted: sanitized.redacted,
    };
  }
  const sanitized = sanitizeText(output);
  return {
    text: sanitized.text,
    bytes: new TextEncoder().encode(sanitized.text),
    binary: output.includes(String.fromCharCode(0)),
    redacted: sanitized.redacted,
  };
}

function sanitizeText(value: string): { readonly text: string; readonly redacted: boolean } {
  let text = value.replace(ANSI_PATTERN, "");
  const before = text;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return { text, redacted: text !== before };
}

function sanitizeSummary(value: string): string {
  return sanitizeText(value).text.slice(0, MAX_SUMMARY_CHARS);
}

function summarizeText(text: string): string {
  const lines = text.split(/\r?\n/);
  return `${lines.length}行、${text.length}文字の出力`;
}

function compactExcerpt(text: string, limit: number): string {
  const excerptLimit = Math.max(1, Math.floor(limit / 3));
  if (text.length <= excerptLimit * 2) return text;
  return `${text.slice(0, excerptLimit)}\n…\n${text.slice(-excerptLimit)}`;
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 7 && byte !== 5) || (byte >= 14 && byte < 32)) suspicious += 1;
  }
  return sample.byteLength > 0 && suspicious / sample.byteLength > 0.01;
}
