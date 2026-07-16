import type { ThreadEvent } from "../webview-protocol";

export const MAX_THREAD_MESSAGES = 1_000;
export const MAX_THREAD_MESSAGE_LENGTH = 100_000;

export type ThreadMessageRole = "user" | "assistant";
export type ThreadMessagePhase = "streaming" | "complete" | "failed";

export interface ThreadMessageViewModel {
  readonly id: string;
  readonly role: ThreadMessageRole;
  readonly text: string;
  readonly phase: ThreadMessagePhase;
  readonly createdAt: number;
  readonly errorMessage?: string;
}

export interface ThreadViewState {
  readonly messages: readonly ThreadMessageViewModel[];
  readonly revision: number;
  readonly lastSequence: number;
  readonly isHydrated: boolean;
  readonly needsSnapshot: boolean;
  readonly snapshotRequestPending: boolean;
}

export type ThreadViewAction =
  | {
      readonly type: "replace-snapshot";
      readonly revision: number;
      readonly eventSequence?: number;
      readonly events: readonly ThreadEvent[];
    }
  | {
      readonly type: "apply-event";
      readonly sequence: number;
      readonly event: ThreadEvent;
    }
  | { readonly type: "request-snapshot" }
  | { readonly type: "snapshot-requested" };

export const INITIAL_THREAD_VIEW_STATE: ThreadViewState = {
  messages: [],
  revision: 0,
  lastSequence: 0,
  isHydrated: false,
  needsSnapshot: false,
  snapshotRequestPending: false,
};

export function threadViewReducer(
  state: ThreadViewState,
  action: ThreadViewAction,
): ThreadViewState {
  switch (action.type) {
    case "replace-snapshot":
      return {
        messages: normalizeSnapshotEvents(action.events),
        revision: action.revision,
        lastSequence: action.eventSequence ?? 0,
        isHydrated: true,
        needsSnapshot: false,
        snapshotRequestPending: false,
      };
    case "request-snapshot":
      return {
        ...state,
        needsSnapshot: true,
      };
    case "snapshot-requested":
      return {
        ...state,
        snapshotRequestPending: true,
      };
    case "apply-event":
      return applyThreadEvent(state, action.sequence, action.event);
  }
}

export function normalizeSnapshotEvents(
  events: readonly ThreadEvent[],
): readonly ThreadMessageViewModel[] {
  let messages: readonly ThreadMessageViewModel[] = [];

  for (const [index, event] of events.entries()) {
    const message = snapshotEventToMessage(event, index);
    if (message) {
      messages = upsertMessage(messages, message);
    }
  }

  return messages.slice(-MAX_THREAD_MESSAGES);
}

export function eventToThreadViewAction(sequence: number, event: ThreadEvent): ThreadViewAction {
  return { type: "apply-event", sequence, event };
}

function applyThreadEvent(
  state: ThreadViewState,
  sequence: number,
  event: ThreadEvent,
): ThreadViewState {
  if (sequence <= state.lastSequence || state.needsSnapshot) {
    return state;
  }

  if (sequence !== state.lastSequence + 1) {
    return {
      ...state,
      needsSnapshot: true,
    };
  }

  if (event.kind === "assistant-text-delta") {
    const messageIndex = state.messages.findIndex(
      (message) => message.id === event.messageId && message.role === "assistant",
    );
    if (messageIndex === -1) {
      return {
        ...state,
        lastSequence: sequence,
        needsSnapshot: true,
      };
    }

    const message = state.messages[messageIndex];
    if (message.phase === "complete" || message.phase === "failed") {
      return {
        ...state,
        lastSequence: sequence,
        needsSnapshot: true,
      };
    }

    const nextMessage: ThreadMessageViewModel = {
      ...message,
      text: appendText(message.text, event.delta),
      phase: event.done ? "complete" : "streaming",
    };
    return {
      ...state,
      messages: replaceMessage(state.messages, messageIndex, nextMessage),
      lastSequence: sequence,
    };
  }

  const nextMessage = eventToMessage(event, sequence);
  if (!nextMessage) {
    return {
      ...state,
      lastSequence: sequence,
    };
  }

  return {
    ...state,
    messages: upsertMessage(state.messages, nextMessage).slice(-MAX_THREAD_MESSAGES),
    lastSequence: sequence,
  };
}

function snapshotEventToMessage(
  event: ThreadEvent,
  index: number,
): ThreadMessageViewModel | undefined {
  if (event.kind === "assistant-text-delta") {
    return undefined;
  }
  return eventToMessage(event, index + 1, `snapshot-message-${index}`);
}

function eventToMessage(
  event: Exclude<ThreadEvent, { kind: "assistant-text-delta" }>,
  sequence: number,
  fallbackId = `event-message-${sequence}`,
): ThreadMessageViewModel | undefined {
  switch (event.kind) {
    case "user-message":
      return {
        id: event.messageId ?? fallbackId,
        role: "user",
        text: limitText(event.text),
        phase: "complete",
        createdAt: sequence,
      };
    case "assistant-text":
      return {
        id: event.messageId ?? fallbackId,
        role: "assistant",
        text: limitText(event.text),
        phase: event.streaming ? "streaming" : "complete",
        createdAt: sequence,
      };
    case "error":
      return {
        id: fallbackId,
        role: "assistant",
        text: "エージェントでエラーが発生しました。",
        phase: "failed",
        createdAt: sequence,
        errorMessage: limitText(event.message),
      };
    case "tool-activity":
      return undefined;
  }
}

function upsertMessage(
  messages: readonly ThreadMessageViewModel[],
  nextMessage: ThreadMessageViewModel,
): readonly ThreadMessageViewModel[] {
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index === -1) {
    return [...messages, nextMessage];
  }

  return replaceMessage(messages, index, nextMessage);
}

function replaceMessage(
  messages: readonly ThreadMessageViewModel[],
  index: number,
  nextMessage: ThreadMessageViewModel,
): readonly ThreadMessageViewModel[] {
  return [...messages.slice(0, index), nextMessage, ...messages.slice(index + 1)];
}

function appendText(current: string, delta: string): string {
  return limitText(`${current}${delta}`);
}

function limitText(text: string): string {
  return text.length > MAX_THREAD_MESSAGE_LENGTH ? text.slice(0, MAX_THREAD_MESSAGE_LENGTH) : text;
}
