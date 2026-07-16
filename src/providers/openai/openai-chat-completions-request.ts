import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
  ProviderToolDefinition,
} from "../provider-types";
import { resolveChatCompletionsProfile } from "./openai-chat-completions-profile";
import type {
  ChatCompletionsAssistantMessage,
  ChatCompletionsContent,
  ChatCompletionsFunctionTool,
  ChatCompletionsMessage,
  ChatCompletionsRequest,
  ChatCompletionsProfile,
  ChatCompletionsSystemMessage,
  ChatCompletionsToolMessage,
  ChatCompletionsToolCall,
  ChatCompletionsUserMessage,
} from "./openai-chat-completions-types";

export class ChatCompletionsRequestMappingError extends Error {
  public override readonly name = "ChatCompletionsRequestMappingError";
}

export function toChatCompletionsRequest(
  request: ProviderRequest,
  profile?: Partial<ChatCompletionsProfile>,
): ChatCompletionsRequest {
  assertNonEmptyString(request.modelId, "modelId");
  const effectiveProfile = resolveChatCompletionsProfile(profile);
  const messages = request.messages.map((message) => mapMessage(message, effectiveProfile));
  const tools = request.tools.map(mapToolDefinition);
  const maxTokens =
    request.options.maxOutputTokens === undefined
      ? {}
      : {
          [effectiveProfile.maxTokensField]: positiveInteger(
            request.options.maxOutputTokens,
            "maxOutputTokens",
          ),
        };
  const reasoning =
    effectiveProfile.reasoningField === "reasoning_effort" &&
    request.options.reasoningEffort !== undefined
      ? { reasoning_effort: request.options.reasoningEffort }
      : {};
  const parallel =
    effectiveProfile.parallelToolCalls === "include"
      ? { parallel_tool_calls: true }
      : effectiveProfile.parallelToolCalls === "false"
        ? { parallel_tool_calls: false }
        : {};
  const mapped: ChatCompletionsRequest = {
    model: request.modelId,
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    stream: true,
    n: 1,
    ...(request.options.temperature === undefined
      ? {}
      : { temperature: finiteNumber(request.options.temperature, "temperature") }),
    ...maxTokens,
    ...reasoning,
    ...parallel,
    ...(effectiveProfile.streamUsage === "include"
      ? { stream_options: { include_usage: true as const } }
      : {}),
  } as ChatCompletionsRequest;
  assertJsonSerializable(mapped, "request");
  return mapped;
}

function mapMessage(
  message: ProviderMessage,
  profile: ChatCompletionsProfile,
): ChatCompletionsMessage {
  if (message.role === "system") {
    if (message.toolCallId !== undefined || message.toolCalls !== undefined) {
      throw mappingError("system message cannot contain tool calls");
    }
    const content = mapTextOnlyContent(message.content, "system message");
    const result: ChatCompletionsSystemMessage = { role: profile.systemRole, content };
    return result;
  }
  if (message.role === "tool") {
    if (message.toolCalls !== undefined)
      throw mappingError("tool message cannot contain tool calls");
    const toolCallId = assertNonEmptyString(message.toolCallId, "toolCallId");
    const content = mapTextOnlyContent(message.content, "tool result");
    const result: ChatCompletionsToolMessage = { role: "tool", tool_call_id: toolCallId, content };
    return result;
  }
  if (message.toolCallId !== undefined)
    throw mappingError("only tool messages can contain toolCallId");
  const toolCalls = message.toolCalls?.map(mapToolCall);
  if (message.role === "assistant") {
    const content = message.content.length === 0 ? null : mapAssistantContent(message.content);
    const result: ChatCompletionsAssistantMessage = {
      role: "assistant",
      content: toolCalls && toolCalls.length > 0 ? content : (content ?? ""),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    return result;
  }
  const result: ChatCompletionsUserMessage = {
    role: "user",
    content: mapUserContent(message.content),
  };
  return result;
}

function mapUserContent(
  content: readonly ProviderContentPart[],
): string | readonly ChatCompletionsContent[] {
  if (content.every((part) => part.type === "text"))
    return content.map((part) => part.text).join("");
  return content.map((part) => {
    if (part.type === "text")
      return { type: "text", text: part.text } satisfies ChatCompletionsContent;
    return {
      type: "image_url",
      image_url: { url: normalizeImage(part) },
    } satisfies ChatCompletionsContent;
  });
}

function mapAssistantContent(content: readonly ProviderContentPart[]): string {
  return mapTextOnlyContent(content, "assistant message");
}

function mapTextOnlyContent(content: readonly ProviderContentPart[], label: string): string {
  if (content.some((part) => part.type !== "text"))
    throw mappingError(`${label} cannot contain images`);
  return content
    .map((part) => {
      if (part.type !== "text") throw mappingError(`${label} cannot contain images`);
      return part.text;
    })
    .join("");
}

function mapToolCall(toolCall: ProviderToolCall): ChatCompletionsToolCall {
  const id = assertNonEmptyString(toolCall.id, "tool call id");
  const name = assertNonEmptyString(toolCall.name, "tool call name");
  let argumentsText: string | undefined;
  try {
    argumentsText = JSON.stringify(toolCall.arguments);
  } catch {
    throw mappingError("tool call arguments are not serializable");
  }
  if (argumentsText === undefined) throw mappingError("tool call arguments are missing");
  return { id, type: "function", function: { name, arguments: argumentsText } };
}

function mapToolDefinition(tool: ProviderToolDefinition): ChatCompletionsFunctionTool {
  const name = assertNonEmptyString(tool.name, "tool name");
  assertJsonSerializable(tool.inputSchema, "tool schema");
  return {
    type: "function",
    function: {
      name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  };
}

function normalizeImage(part: Extract<ProviderContentPart, { readonly type: "image" }>): string {
  const mediaType = assertNonEmptyString(part.mediaType, "image mediaType");
  if (!/^[^\s/]+\/[^\s/]+$/.test(mediaType) || hasControlCharacter(part.data)) {
    throw mappingError("image content is invalid");
  }
  const data = assertNonEmptyString(part.data, "image data");
  return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
}

function assertJsonSerializable(value: unknown, label: string): void {
  try {
    if (JSON.stringify(value) === undefined) throw mappingError(`${label} is missing`);
  } catch (error) {
    if (error instanceof ChatCompletionsRequestMappingError) throw error;
    throw mappingError(`${label} is not serializable`);
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw mappingError(`${label} is invalid`);
  return value;
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw mappingError(`${label} is invalid`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw mappingError(`${label} is invalid`);
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function mappingError(reason: string): ChatCompletionsRequestMappingError {
  return new ChatCompletionsRequestMappingError(
    `Chat Completions request mapping failed: ${reason}`,
  );
}
