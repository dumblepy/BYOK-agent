import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderToolDefinition,
} from "../provider-types";

export interface ChatCompletionsProfile {
  readonly systemRole: "system" | "developer";
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly reasoningField: "none" | "reasoning_effort";
  readonly reasoningDeltaField: "none" | "reasoning_content" | "reasoning";
  readonly streamUsage: "include" | "omit";
  readonly parallelToolCalls: "include" | "omit" | "false";
  readonly toolArguments: "string" | "object" | "auto";
  readonly toolIndex: "required" | "id-fallback";
  readonly legacyFunctionCall: "disabled" | "enabled";
  readonly synthesizeToolCallId: "disabled" | "enabled";
  readonly allowEofAfterFinish: boolean;
}

export interface ChatCompletionsTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ChatCompletionsImageContent {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export type ChatCompletionsContent = ChatCompletionsTextContent | ChatCompletionsImageContent;

export interface ChatCompletionsUserMessage {
  readonly role: "user";
  readonly content: string | readonly ChatCompletionsContent[];
}

export interface ChatCompletionsSystemMessage {
  readonly role: "system" | "developer";
  readonly content: string;
}

export interface ChatCompletionsAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: readonly ChatCompletionsToolCall[];
}

export interface ChatCompletionsToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatCompletionsToolMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export type ChatCompletionsMessage =
  | ChatCompletionsSystemMessage
  | ChatCompletionsUserMessage
  | ChatCompletionsAssistantMessage
  | ChatCompletionsToolMessage;

export interface ChatCompletionsFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  };
}

export interface ChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly ChatCompletionsMessage[];
  readonly tools?: readonly ChatCompletionsFunctionTool[];
  readonly stream: true;
  readonly n: 1;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly reasoning_effort?: string;
  readonly parallel_tool_calls?: boolean;
  readonly stream_options?: { readonly include_usage: true };
}

export interface ChatCompletionsSseEvent {
  readonly event: string;
  readonly data: string;
}

export type ChatCompletionsContentPart = Extract<
  ProviderContentPart,
  { readonly type: "text" | "image" }
>;
export type ChatCompletionsProviderMessage = ProviderMessage;
export type ChatCompletionsProviderToolDefinition = ProviderToolDefinition;
