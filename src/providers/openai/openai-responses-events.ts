import { createProviderError, normalizeProviderError } from "../provider-error";
import type { ProviderEvent, ProviderStopReason } from "../provider-types";
import type { ResponsesSseEvent } from "./openai-responses-types";

interface PendingFunctionCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  argumentsText: string;
}

interface NormalizerState {
  readonly requestId: string;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly pending: Map<string, PendingFunctionCall>;
  readonly completedCallIds: Set<string>;
  sawToolCall: boolean;
  usageEmitted: boolean;
  terminal: boolean;
}

export async function* normalizeResponsesEvents(
  events: AsyncIterable<ResponsesSseEvent>,
  requestId: string,
  allowedToolNames: ReadonlySet<string>,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const state: NormalizerState = {
    requestId,
    allowedToolNames,
    pending: new Map(),
    completedCallIds: new Set(),
    sawToolCall: false,
    usageEmitted: false,
    terminal: false,
  };

  for await (const event of events) {
    if (signal.aborted) {
      yield { type: "cancelled" };
      return;
    }
    if (state.terminal) return;

    const output = processSseEvent(event, state);
    for (const normalized of output.events) yield normalized;
    if (output.events.some((normalized) => normalized.type === "error")) {
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
  if (state.pending.size > 0) {
    yield providerErrorEvent(state);
    return;
  }
  yield { type: "completed", stopReason: "unknown" };
}

interface ProcessedEvent {
  readonly events: readonly ProviderEvent[];
  readonly terminal?: boolean;
}

function processSseEvent(event: ResponsesSseEvent, state: NormalizerState): ProcessedEvent {
  if (event.event === "done") {
    if (state.pending.size > 0) return { events: [providerErrorEvent(state)] };
    return { events: [{ type: "completed", stopReason: "unknown" }], terminal: true };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (!isRecord(parsed)) throw new Error("SSE payload is not an object");
    payload = parsed;
  } catch {
    return { events: [providerErrorEvent(state)] };
  }

  const type = event.event || stringValue(payload.type);
  switch (type) {
    case "response.output_text.delta":
      return textDelta(payload, "text-delta", state);
    case "response.reasoning_summary_text.delta":
      return textDelta(payload, "reasoning-delta", state);
    case "response.output_item.added":
      return addFunctionCall(payload, state);
    case "response.function_call_arguments.delta":
      return appendFunctionCall(payload, state);
    case "response.function_call_arguments.done":
      return completeFunctionCall(payload, state);
    case "response.output_item.done":
      return completeOutputItem(payload, state);
    case "response.completed":
      return completeResponse(payload, state, false);
    case "response.incomplete":
      return completeResponse(payload, state, true);
    case "response.failed":
    case "error":
      return { events: [failureEvent(payload, state)] };
    default:
      return { events: [] };
  }
}

function textDelta(
  payload: Record<string, unknown>,
  type: "text-delta" | "reasoning-delta",
  state: NormalizerState,
): ProcessedEvent {
  const delta = stringValue(payload.delta);
  return delta === undefined
    ? { events: [providerErrorEvent(state)] }
    : { events: [{ type, text: delta }] };
}

function addFunctionCall(payload: Record<string, unknown>, state: NormalizerState): ProcessedEvent {
  const item = recordValue(payload.item);
  if (!item || stringValue(item.type) !== "function_call") return { events: [] };

  const itemId = stringValue(item.id) ?? stringValue(item.call_id);
  const callId = stringValue(item.call_id);
  const name = stringValue(item.name);
  if (!itemId || !callId || !name || !state.allowedToolNames.has(name)) {
    return { events: [providerErrorEvent(state)] };
  }
  if (
    state.pending.has(itemId) ||
    state.completedCallIds.has(callId) ||
    [...state.pending.values()].some((call) => call.callId === callId)
  ) {
    return { events: [providerErrorEvent(state)] };
  }

  const argumentsText = stringValue(item.arguments) ?? "";
  state.pending.set(itemId, { itemId, callId, name, argumentsText });
  const events: ProviderEvent[] = [{ type: "tool-call-start", id: callId, name }];
  if (argumentsText.length > 0) {
    events.push({ type: "tool-call-delta", id: callId, argumentsDelta: argumentsText });
  }
  return { events };
}

function appendFunctionCall(
  payload: Record<string, unknown>,
  state: NormalizerState,
): ProcessedEvent {
  const itemId = stringValue(payload.item_id);
  const delta = stringValue(payload.delta);
  const call = itemId === undefined ? undefined : state.pending.get(itemId);
  if (!call || delta === undefined) return { events: [providerErrorEvent(state)] };
  call.argumentsText += delta;
  return { events: [{ type: "tool-call-delta", id: call.callId, argumentsDelta: delta }] };
}

function completeFunctionCall(
  payload: Record<string, unknown>,
  state: NormalizerState,
): ProcessedEvent {
  const itemId = stringValue(payload.item_id);
  const call = itemId === undefined ? undefined : state.pending.get(itemId);
  if (!call) return { events: [providerErrorEvent(state)] };
  return finishFunctionCall(call, stringValue(payload.arguments), state);
}

function completeOutputItem(
  payload: Record<string, unknown>,
  state: NormalizerState,
): ProcessedEvent {
  const item = recordValue(payload.item);
  if (!item || stringValue(item.type) !== "function_call") return { events: [] };
  const itemId = stringValue(item.id) ?? stringValue(item.call_id);
  const call = itemId === undefined ? undefined : state.pending.get(itemId);
  if (!call) return { events: [providerErrorEvent(state)] };
  return finishFunctionCall(call, stringValue(item.arguments), state);
}

function finishFunctionCall(
  call: PendingFunctionCall,
  finalArguments: string | undefined,
  state: NormalizerState,
): ProcessedEvent {
  const argumentsText =
    finalArguments === undefined || finalArguments.length === 0
      ? call.argumentsText
      : finalArguments;
  let args: unknown;
  try {
    args = JSON.parse(argumentsText);
  } catch {
    return { events: [providerErrorEvent(state)] };
  }
  state.pending.delete(call.itemId);
  state.completedCallIds.add(call.callId);
  state.sawToolCall = true;
  return {
    events: [{ type: "tool-call", id: call.callId, name: call.name, arguments: args }],
  };
}

function completeResponse(
  payload: Record<string, unknown>,
  state: NormalizerState,
  incomplete: boolean,
): ProcessedEvent {
  const response = recordValue(payload.response) ?? payload;
  const events: ProviderEvent[] = [];
  for (const outputEvent of materializeOutputToolCalls(response, state)) {
    events.push(outputEvent);
    if (outputEvent.type === "error") return { events };
  }
  if (state.pending.size > 0) return { events: [providerErrorEvent(state)] };

  const usage = recordValue(response.usage);
  if (usage && !state.usageEmitted) {
    const usageEvent = toUsageEvent(usage);
    if (!usageEvent) return { events: [providerErrorEvent(state)] };
    state.usageEmitted = true;
    events.push(usageEvent);
  }

  const incompleteReason = stringValue(recordValue(response.incomplete_details)?.reason);
  const responseStatus = stringValue(response.status);
  const stopReason =
    incomplete || responseStatus === "incomplete" || incompleteReason !== undefined
      ? toStopReason(incompleteReason)
      : state.sawToolCall
        ? "tool-call"
        : "end-turn";
  events.push({ type: "completed", stopReason });
  return { events, terminal: true };
}

function materializeOutputToolCalls(
  response: Record<string, unknown>,
  state: NormalizerState,
): ProviderEvent[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const events: ProviderEvent[] = [];
  for (const candidate of output) {
    const item = recordValue(candidate);
    if (!item || stringValue(item.type) !== "function_call") continue;
    const callId = stringValue(item.call_id);
    if (!callId || state.completedCallIds.has(callId)) continue;
    const itemId = stringValue(item.id) ?? callId;
    const pending = state.pending.get(itemId);
    if (pending) {
      const completed = finishFunctionCall(pending, stringValue(item.arguments), state);
      events.push(...completed.events);
      continue;
    }
    const added = addFunctionCall({ item }, state);
    events.push(...added.events);
    if (added.events.some((event) => event.type === "error")) return events;
    const completed = completeOutputItem({ item }, state);
    events.push(...completed.events);
    if (completed.events.some((event) => event.type === "error")) return events;
  }
  return events;
}

function toUsageEvent(usage: Record<string, unknown>): ProviderEvent | undefined {
  const inputTokens = safeTokenCount(usage.input_tokens);
  const outputTokens = safeTokenCount(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const inputDetails = recordValue(usage.input_tokens_details);
  const outputDetails = recordValue(usage.output_tokens_details);
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

function toStopReason(reason: string | undefined): ProviderStopReason {
  if (reason === "max_output_tokens") return "max-tokens";
  if (reason === "content_filter") return "content-filter";
  return "unknown";
}

function failureEvent(payload: Record<string, unknown>, state: NormalizerState): ProviderEvent {
  const response = recordValue(payload.response);
  const error = recordValue(payload.error) ?? recordValue(response?.error) ?? payload;
  const code = stringValue(error.code);
  const status = safeStatus(error.status ?? response?.status ?? payload.status);
  return {
    type: "error",
    error: normalizeProviderError(
      {
        source: "stream",
        code: code === "invalid_prompt" ? "bad_request" : code,
        providerType: stringValue(error.type),
        message: stringValue(error.message),
        status,
      },
      { requestId: state.requestId },
    ),
  };
}

function providerErrorEvent(state: NormalizerState): ProviderEvent {
  return { type: "error", error: createProviderError("bad-request", state.requestId) };
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
