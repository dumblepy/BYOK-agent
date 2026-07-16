export interface ResponsesTextContent {
  readonly type: "input_text";
  readonly text: string;
}

export interface ResponsesImageContent {
  readonly type: "input_image";
  readonly image_url: string;
  readonly detail: "auto";
}

export type ResponsesMessageContent = ResponsesTextContent | ResponsesImageContent;

export interface ResponsesMessageInput {
  readonly type: "message";
  readonly role: "user" | "assistant";
  readonly content: readonly ResponsesMessageContent[];
}

export interface ResponsesFunctionCallInput {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ResponsesFunctionCallOutputInput {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string | readonly ResponsesMessageContent[];
}

export type ResponsesInputItem =
  ResponsesMessageInput | ResponsesFunctionCallInput | ResponsesFunctionCallOutputInput;

export interface ResponsesFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters: unknown;
}

export interface ResponsesRequest {
  readonly model: string;
  readonly instructions?: string;
  readonly input: readonly ResponsesInputItem[];
  readonly tools?: readonly ResponsesFunctionTool[];
  readonly temperature?: number;
  readonly max_output_tokens?: number;
  readonly reasoning?: { readonly effort: string };
  readonly stream: true;
  readonly parallel_tool_calls: true;
  readonly truncation: "disabled";
}

export interface ResponsesSseEvent {
  readonly event: string;
  readonly data: string;
}
