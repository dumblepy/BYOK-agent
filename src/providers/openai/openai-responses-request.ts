import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
  ProviderToolDefinition,
} from "../provider-types";
import type {
  ResponsesFunctionCallInput,
  ResponsesFunctionCallOutputInput,
  ResponsesFunctionTool,
  ResponsesImageContent,
  ResponsesInputItem,
  ResponsesMessageContent,
  ResponsesMessageInput,
  ResponsesRequest,
} from "./openai-responses-types";

export class ResponsesRequestMappingError extends Error {
  public override readonly name = "ResponsesRequestMappingError";
}

export function toResponsesRequest(request: ProviderRequest): ResponsesRequest {
  assertNonEmptyString(request.modelId, "modelId");

  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const message of request.messages) {
    mapMessage(message, instructions, input);
  }

  const tools = request.tools.map(mapToolDefinition);
  const mapped: ResponsesRequest = {
    model: request.modelId,
    input,
    stream: true,
    parallel_tool_calls: true,
    truncation: "disabled",
    ...(instructions.length === 0 ? {} : { instructions: instructions.join("\n\n") }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(request.options.temperature === undefined
      ? {}
      : { temperature: finiteNumber(request.options.temperature, "temperature") }),
    ...(request.options.maxOutputTokens === undefined
      ? {}
      : {
          max_output_tokens: positiveInteger(request.options.maxOutputTokens, "maxOutputTokens"),
        }),
    ...(request.options.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: request.options.reasoningEffort } }),
  };

  assertJsonSerializable(mapped, "request");
  return mapped;
}

function mapMessage(
  message: ProviderMessage,
  instructions: string[],
  input: ResponsesInputItem[],
): void {
  if (message.role === "system") {
    if (message.toolCallId !== undefined || message.toolCalls !== undefined) {
      throw mappingError("system message cannot contain tool calls");
    }
    for (const part of message.content) {
      if (part.type !== "text") {
        throw mappingError("system message cannot contain images");
      }
      instructions.push(part.text);
    }
    return;
  }

  if (message.role === "tool") {
    if (message.toolCalls !== undefined) {
      throw mappingError("tool message cannot contain tool calls");
    }
    const callId = assertNonEmptyString(message.toolCallId, "toolCallId");
    const output = mapToolResult(message.content);
    const item: ResponsesFunctionCallOutputInput = {
      type: "function_call_output",
      call_id: callId,
      output,
    };
    input.push(item);
    return;
  }

  if (message.toolCallId !== undefined) {
    throw mappingError("only tool messages can contain toolCallId");
  }

  const content = mapMessageContent(message.content);
  if (content.length > 0 || message.toolCalls === undefined || message.toolCalls.length === 0) {
    const item: ResponsesMessageInput = {
      type: "message",
      role: message.role,
      content,
    };
    input.push(item);
  }

  for (const toolCall of message.toolCalls ?? []) {
    input.push(mapToolCall(toolCall));
  }
}

function mapMessageContent(content: readonly ProviderContentPart[]): ResponsesMessageContent[] {
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    return mapImage(part);
  });
}

function mapToolResult(
  content: readonly ProviderContentPart[],
): string | readonly ResponsesMessageContent[] {
  if (content.every((part) => part.type === "text")) {
    return content.map((part) => part.text).join("");
  }
  return mapMessageContent(content);
}

function mapImage(
  part: Extract<ProviderContentPart, { readonly type: "image" }>,
): ResponsesImageContent {
  const mediaType = assertNonEmptyString(part.mediaType, "image mediaType");
  if (!/^[^\s/]+\/[^\s/]+$/.test(mediaType) || hasControlCharacter(part.data)) {
    throw mappingError("image content is invalid");
  }
  const data = assertNonEmptyString(part.data, "image data");
  return {
    type: "input_image",
    image_url: data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`,
    detail: "auto",
  };
}

function mapToolCall(toolCall: ProviderToolCall): ResponsesFunctionCallInput {
  const callId = assertNonEmptyString(toolCall.id, "tool call id");
  const name = assertNonEmptyString(toolCall.name, "tool call name");
  let argumentsText: string;
  try {
    argumentsText = JSON.stringify(toolCall.arguments);
  } catch {
    throw mappingError("tool call arguments are not serializable");
  }
  if (argumentsText === undefined) throw mappingError("tool call arguments are missing");
  return { type: "function_call", call_id: callId, name, arguments: argumentsText };
}

function mapToolDefinition(tool: ProviderToolDefinition): ResponsesFunctionTool {
  const name = assertNonEmptyString(tool.name, "tool name");
  assertJsonSerializable(tool.inputSchema, "tool schema");
  return {
    type: "function",
    name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.inputSchema,
  };
}

function assertJsonSerializable(value: unknown, label: string): void {
  try {
    if (JSON.stringify(value) === undefined) throw mappingError(`${label} is missing`);
  } catch (error) {
    if (error instanceof ResponsesRequestMappingError) throw error;
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

function mappingError(reason: string): ResponsesRequestMappingError {
  return new ResponsesRequestMappingError(`Responses request mapping failed: ${reason}`);
}
