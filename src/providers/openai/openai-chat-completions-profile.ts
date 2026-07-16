import type { ChatCompletionsProfile } from "./openai-chat-completions-types";

export const DEFAULT_CHAT_COMPLETIONS_PROFILE: ChatCompletionsProfile = Object.freeze({
  systemRole: "system",
  maxTokensField: "max_tokens",
  reasoningField: "none",
  reasoningDeltaField: "none",
  streamUsage: "omit",
  parallelToolCalls: "omit",
  toolArguments: "string",
  toolIndex: "required",
  legacyFunctionCall: "disabled",
  synthesizeToolCallId: "disabled",
  allowEofAfterFinish: false,
});

const PROFILE_KEYS = new Set<keyof ChatCompletionsProfile>([
  "systemRole",
  "maxTokensField",
  "reasoningField",
  "reasoningDeltaField",
  "streamUsage",
  "parallelToolCalls",
  "toolArguments",
  "toolIndex",
  "legacyFunctionCall",
  "synthesizeToolCallId",
  "allowEofAfterFinish",
]);

export function resolveChatCompletionsProfile(
  profile: Partial<ChatCompletionsProfile> | undefined,
): ChatCompletionsProfile {
  if (profile === undefined) return DEFAULT_CHAT_COMPLETIONS_PROFILE;
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key as keyof ChatCompletionsProfile)) {
      throw new Error("Unknown Chat Completions profile option");
    }
  }
  const resolved = { ...DEFAULT_CHAT_COMPLETIONS_PROFILE, ...profile };
  assertOneOf(resolved.systemRole, ["system", "developer"]);
  assertOneOf(resolved.maxTokensField, ["max_tokens", "max_completion_tokens"]);
  assertOneOf(resolved.reasoningField, ["none", "reasoning_effort"]);
  assertOneOf(resolved.reasoningDeltaField, ["none", "reasoning_content", "reasoning"]);
  assertOneOf(resolved.streamUsage, ["include", "omit"]);
  assertOneOf(resolved.parallelToolCalls, ["include", "omit", "false"]);
  assertOneOf(resolved.toolArguments, ["string", "object", "auto"]);
  assertOneOf(resolved.toolIndex, ["required", "id-fallback"]);
  assertOneOf(resolved.legacyFunctionCall, ["disabled", "enabled"]);
  assertOneOf(resolved.synthesizeToolCallId, ["disabled", "enabled"]);
  if (typeof resolved.allowEofAfterFinish !== "boolean") {
    throw new Error("Invalid allowEofAfterFinish");
  }
  return Object.freeze(resolved);
}

function assertOneOf<T extends string>(value: string, values: readonly T[]): asserts value is T {
  if (!values.includes(value as T)) throw new Error("Invalid Chat Completions profile option");
}
