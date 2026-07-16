import type { ThreadRecord, ThreadStore } from "./thread-store";

export const DEFAULT_THREAD_TITLE = "新しいスレッド";
export const PROVISIONAL_TITLE_MAX_CODE_POINTS = 60;

export type ThreadTitleSource = "default" | "provisional" | "llm" | "user";

export interface TitleGenerationPort {
  generate(input: {
    readonly text: string;
    readonly modelId: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface ThreadTitleServiceOptions {
  readonly autoNaming?: boolean;
  readonly titleGenerationPort?: TitleGenerationPort;
}

export function createProvisionalTitle(text: string): string {
  const normalized = normalizeTitleCandidate(text);
  if (normalized.length === 0) return DEFAULT_THREAD_TITLE;
  return truncateCodePoints(normalized, PROVISIONAL_TITLE_MAX_CODE_POINTS);
}

export function normalizeGeneratedTitle(value: string): string | undefined {
  const normalized = normalizeTitleCandidate(value);
  if (normalized.length === 0) return undefined;
  return truncateCodePoints(normalized, PROVISIONAL_TITLE_MAX_CODE_POINTS);
}

export function normalizeTitleCandidate(value: string): string {
  const redacted = value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(?:bearer\s+)[a-z0-9._~+/=-]+/giu, "[機密情報]")
    .replace(
      /\b(?:sk-[a-z0-9_-]{8,}|api[-_]?key|access[-_]?token|authorization)\s*[:=]\s*[^\s,;]+/giu,
      "[機密情報]",
    )
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...redacted]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateCodePoints(value: string, max: number): string {
  const points = [...value];
  if (points.length <= max) return value;
  return `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

export class ThreadTitleService {
  public constructor(
    private readonly threadStore: ThreadStore,
    private readonly options: ThreadTitleServiceOptions = {},
  ) {}

  public async handleFirstUserMessage(threadId: string, text: string): Promise<ThreadRecord> {
    const provisional = createProvisionalTitle(text);
    let current = await this.threadStore.get(threadId);
    if (!current) throw new Error("The thread was not found");

    if (current.titleSource === "default") {
      current = await this.threadStore.applyGeneratedTitle(
        threadId,
        current.revision,
        provisional,
        "provisional",
      );
    }

    if (
      this.options.autoNaming !== true ||
      this.options.titleGenerationPort === undefined ||
      current.titleSource !== "provisional" ||
      current.modelId === undefined
    ) {
      return current;
    }

    const controller = new AbortController();
    try {
      const generated = await this.options.titleGenerationPort.generate({
        text: normalizeTitleCandidate(text),
        modelId: current.modelId,
        signal: controller.signal,
      });
      const title = normalizeGeneratedTitle(generated);
      if (title === undefined) return current;
      const latest = await this.threadStore.get(threadId);
      if (!latest || latest.titleSource !== "provisional") return latest ?? current;
      return await this.threadStore.applyGeneratedTitle(threadId, latest.revision, title, "llm");
    } catch {
      return current;
    } finally {
      controller.abort();
    }
  }
}
