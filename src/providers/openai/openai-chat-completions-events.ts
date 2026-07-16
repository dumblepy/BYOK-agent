import { createProviderError, normalizeProviderError } from "../provider-error";
import type { ProviderEvent, ProviderStopReason } from "../provider-types";
import { resolveChatCompletionsProfile } from "./openai-chat-completions-profile";
import type {
  ChatCompletionsProfile,
  ChatCompletionsSseEvent,
} from "./openai-chat-completions-types";

interface PendingToolCall {
  readonly key: string;
  id?: string;
  name?: string;
  argumentMode: "unset" | "string" | "object";
  argumentsText: string;
  argumentObject?: unknown;
  started: boolean;
  closed: boolean;
}

interface NormalizerState {
  readonly requestId: string;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly profile: ChatCompletionsProfile;
  readonly pending: Map<string, PendingToolCall>;
  readonly completed: Set<string>;
  sawToolCall: boolean;
  finishReason?: string;
  usage?: ProviderEvent;
  terminal: boolean;
}

interface ProcessedEvent {
  readonly events: readonly ProviderEvent[];
  readonly terminal?: boolean;
}

export async function* normalizeChatCompletionsEvents(
  events: AsyncIterable<ChatCompletionsSseEvent>,
  requestId: string,
  allowedToolNames: ReadonlySet<string>,
  signal: AbortSignal,
  profile?: Partial<ChatCompletionsProfile>,
): AsyncIterable<ProviderEvent> {
  const state: NormalizerState = {
    requestId,
    allowedToolNames,
    profile: resolveChatCompletionsProfile(profile),
    pending: new Map(),
    completed: new Set(),
    sawToolCall: false,
    terminal: false,
  };
  for await (const event of events) {
    if (signal.aborted) {
      yield { type: "cancelled" };
      return;
    }
    if (state.terminal) return;
    const output = processEvent(event, state);
    for (const normalized of output.events) yield normalized;
    if (output.events.some((item) => item.type === "error" || item.type === "cancelled")) {
      state.terminal = true;
      return;
    }
    if (output.terminal) {
      state.terminal = true;
      return;
    }
  }
  if (signal.aborted) {
    yield { type: "cancelled" };
    return;
  }
  if (state.terminal) return;
  if (state.profile.allowEofAfterFinish && state.finishReason !== undefined) {
    const output = finalize(state);
    for (const event of output.events) yield event;
    return;
  }
  yield providerErrorEvent(state);
}

function processEvent(event: ChatCompletionsSseEvent, state: NormalizerState): ProcessedEvent {
  if (event.data === "[DONE]") return finalize(state);
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (!isRecord(parsed)) throw new Error("Chunk is not an object");
    payload = parsed;
  } catch {
    return { events: [providerErrorEvent(state)] };
  }
  if (payload.error !== undefined || event.event === "error") {
    return { events: [failureEvent(payload, state)] };
  }
  const usage = recordValue(payload.usage);
  if (usage !== undefined) {
    const usageEvent = toUsageEvent(usage);
    if (!usageEvent) return { events: [providerErrorEvent(state)] };
    state.usage = usageEvent;
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { events: [] };
  if (choices.length !== 1) return { events: [providerErrorEvent(state)] };
  const choice = recordValue(choices[0]);
  if (!choice || (choice.index !== undefined && choice.index !== 0)) {
    return { events: [providerErrorEvent(state)] };
  }
  const chunkFinishReason =
    choice.finish_reason === undefined || choice.finish_reason === null
      ? undefined
      : stringValue(choice.finish_reason);
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null &&
    chunkFinishReason === undefined
  ) {
    return { events: [providerErrorEvent(state)] };
  }
  if (
    chunkFinishReason !== undefined &&
    state.finishReason !== undefined &&
    state.finishReason !== chunkFinishReason
  ) {
    return { events: [providerErrorEvent(state)] };
  }
  const delta = recordValue(choice.delta);
  if (!delta) return { events: [] };
  if (
    state.finishReason !== undefined &&
    (delta.content !== undefined || delta.tool_calls !== undefined)
  ) {
    return { events: [providerErrorEvent(state)] };
  }
  const output: ProviderEvent[] = [];
  if (delta.content !== undefined && delta.content !== null) {
    const text = stringValue(delta.content);
    if (text === undefined) return { events: [providerErrorEvent(state)] };
    output.push({ type: "text-delta", text });
  }
  const reasoning = state.profile.reasoningDeltaField;
  if (reasoning !== "none" && delta[reasoning] !== undefined && delta[reasoning] !== null) {
    const text = stringValue(delta[reasoning]);
    if (text === undefined) return { events: [providerErrorEvent(state)] };
    output.push({ type: "reasoning-delta", text });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const candidate of delta.tool_calls) {
      const result = addToolCall(candidate, state, choice.index === undefined ? 0 : choice.index);
      if (result.error) return { events: [providerErrorEvent(state)] };
      output.push(...result.events);
    }
  }
  const legacy = recordValue(delta.function_call);
  if (legacy !== undefined) {
    if (state.profile.legacyFunctionCall !== "enabled")
      return { events: [providerErrorEvent(state)] };
    const result = addLegacyToolCall(legacy, state);
    if (result.error) return { events: [providerErrorEvent(state)] };
    output.push(...result.events);
  }
  if (chunkFinishReason !== undefined) state.finishReason = chunkFinishReason;
  return { events: output };
}

function addToolCall(
  candidate: unknown,
  state: NormalizerState,
  choiceIndex: number,
): { events: ProviderEvent[]; error?: true } {
  const value = recordValue(candidate);
  if (!value) return { events: [], error: true };
  const id = stringValue(value.id);
  const index = safeIndex(value.index);
  const functionValue = recordValue(value.function);
  const name = stringValue(functionValue?.name);
  const type = value.type;
  if (type !== undefined && type !== null && type !== "function")
    return { events: [], error: true };
  if (index === undefined && (state.profile.toolIndex === "required" || id === undefined)) {
    return { events: [], error: true };
  }
  const key = index === undefined ? `${choiceIndex}:id:${id}` : `${choiceIndex}:index:${index}`;
  const call = getOrCreateCall(key, state);
  if (!call) return { events: [], error: true };
  if (id !== undefined && id.length === 0) return { events: [], error: true };
  if (id !== undefined && call.id !== undefined && call.id !== id)
    return { events: [], error: true };
  if (name !== undefined && name.length === 0) return { events: [], error: true };
  if (name !== undefined && call.name !== undefined && call.name !== name)
    return { events: [], error: true };
  if (id !== undefined) call.id = id;
  if (name !== undefined) call.name = name;
  const events: ProviderEvent[] = [];
  if (!call.started && call.id !== undefined && call.name !== undefined) {
    events.push({ type: "tool-call-start", id: call.id, name: call.name });
    call.started = true;
    if (call.argumentsText.length > 0) {
      events.push({ type: "tool-call-delta", id: call.id, argumentsDelta: call.argumentsText });
    }
  }
  const argumentsValue = functionValue?.arguments;
  if (argumentsValue !== undefined) {
    const appended = appendArguments(call, argumentsValue, state.profile);
    if (!appended) return { events: [], error: true };
    if (typeof argumentsValue === "string" && argumentsValue.length > 0 && call.started) {
      events.push({ type: "tool-call-delta", id: call.id!, argumentsDelta: argumentsValue });
    }
  }
  return { events };
}

function addLegacyToolCall(
  value: Record<string, unknown>,
  state: NormalizerState,
): { events: ProviderEvent[]; error?: true } {
  const existing = [...state.pending.values()].find((call) => call.key === "legacy");
  const call = existing ?? getOrCreateCall("legacy", state);
  if (!call) return { events: [], error: true };
  const name = stringValue(value.name);
  if (name !== undefined && call.name !== undefined && name !== call.name)
    return { events: [], error: true };
  if (name !== undefined) call.name = name;
  if (call.id === undefined && state.profile.synthesizeToolCallId === "enabled") {
    call.id = `call_${state.requestId}_legacy`;
  }
  const events: ProviderEvent[] = [];
  if (!call.started && call.id !== undefined && call.name !== undefined) {
    events.push({ type: "tool-call-start", id: call.id, name: call.name });
    call.started = true;
  }
  if (value.arguments !== undefined) {
    const argumentValue = value.arguments;
    if (!appendArguments(call, argumentValue, state.profile)) return { events: [], error: true };
    if (typeof argumentValue === "string" && argumentValue.length > 0 && call.started) {
      events.push({ type: "tool-call-delta", id: call.id!, argumentsDelta: argumentValue });
    }
  }
  return { events };
}

function appendArguments(
  call: PendingToolCall,
  value: unknown,
  profile: ChatCompletionsProfile,
): boolean {
  if (typeof value === "string") {
    if (call.argumentMode === "object" || (profile.toolArguments === "object" && value.length > 0))
      return false;
    call.argumentMode = "string";
    call.argumentsText += value;
    return true;
  }
  if (!isJsonValue(value) || profile.toolArguments === "string") return false;
  if (call.argumentMode === "string") return false;
  if (
    call.argumentMode === "object" &&
    JSON.stringify(call.argumentObject) !== JSON.stringify(value)
  )
    return false;
  call.argumentMode = "object";
  call.argumentObject = value;
  return true;
}

function finalize(state: NormalizerState): ProcessedEvent {
  const events: ProviderEvent[] = [];
  for (const call of state.pending.values()) {
    if (!call.id || !call.name || !state.allowedToolNames.has(call.name) || call.closed) {
      return { events: [providerErrorEvent(state)] };
    }
    let args: unknown;
    if (call.argumentMode === "object") {
      args = call.argumentObject;
    } else {
      if (call.argumentsText.length === 0) return { events: [providerErrorEvent(state)] };
      try {
        args = JSON.parse(call.argumentsText);
      } catch {
        return { events: [providerErrorEvent(state)] };
      }
    }
    call.closed = true;
    state.completed.add(call.key);
    state.sawToolCall = true;
    events.push({ type: "tool-call", id: call.id, name: call.name, arguments: args });
  }
  state.pending.clear();
  if (state.usage !== undefined) events.push(state.usage);
  events.push({ type: "completed", stopReason: stopReason(state) });
  return { events, terminal: true };
}

function stopReason(state: NormalizerState): ProviderStopReason {
  if (
    state.sawToolCall ||
    state.finishReason === "tool_calls" ||
    state.finishReason === "function_call"
  )
    return "tool-call";
  switch (state.finishReason) {
    case "stop":
    case "stop_sequence":
    case "eos":
      return "end-turn";
    case "length":
      return "max-tokens";
    case "content_filter":
      return "content-filter";
    default:
      return "unknown";
  }
}

function getOrCreateCall(key: string, state: NormalizerState): PendingToolCall | undefined {
  if (state.completed.has(key)) return undefined;
  const existing = state.pending.get(key);
  if (existing) return existing;
  const call: PendingToolCall = {
    key,
    argumentMode: "unset",
    argumentsText: "",
    started: false,
    closed: false,
  };
  state.pending.set(key, call);
  return call;
}

function toUsageEvent(usage: Record<string, unknown>): ProviderEvent | undefined {
  const inputTokens = safeTokenCount(usage.prompt_tokens);
  const outputTokens = safeTokenCount(usage.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const inputDetails = recordValue(usage.prompt_tokens_details);
  const outputDetails = recordValue(usage.completion_tokens_details);
  const cachedTokens = safeTokenCount(inputDetails?.cached_tokens);
  const reasoningTokens = safeTokenCount(outputDetails?.reasoning_tokens);
  return {
    type: "usage",
    inputTokens,
    outputTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function failureEvent(payload: Record<string, unknown>, state: NormalizerState): ProviderEvent {
  const error = recordValue(payload.error) ?? payload;
  return {
    type: "error",
    error: normalizeProviderError(
      {
        source: "stream",
        code: stringValue(error.code),
        providerType: stringValue(error.type),
        message: stringValue(error.message),
        status: safeStatus(error.status),
      },
      { requestId: state.requestId },
    ),
  };
}

function providerErrorEvent(state: NormalizerState): ProviderEvent {
  return { type: "error", error: createProviderError("bad-request", state.requestId) };
}

function safeIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
