import type { ChatCompletionsSseEvent } from "./openai-chat-completions-types";

export class ChatCompletionsSsePayloadTooLargeError extends Error {
  public override readonly name = "ChatCompletionsSsePayloadTooLargeError";
}

export async function* parseChatCompletionsSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
): AsyncIterable<ChatCompletionsSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let streamCompleted = false;
  let bytesRead = 0;
  try {
    while (true) {
      if (signal.aborted) return;
      const result = await reader.read();
      if (result.done) {
        streamCompleted = true;
        buffer += decoder.decode();
        break;
      }
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes) throw new ChatCompletionsSsePayloadTooLargeError();
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const line = takeLine(buffer);
        if (!line) break;
        buffer = line.rest;
        const processed = processLine(line.value, eventName, dataLines);
        eventName = processed.eventName;
        dataLines = processed.dataLines;
        if (processed.emitted && !signal.aborted) yield processed.emitted;
      }
    }
    if (buffer.length > 0) {
      const processed = processLine(buffer, eventName, dataLines);
      eventName = processed.eventName;
      dataLines = processed.dataLines;
      if (processed.emitted && !signal.aborted) yield processed.emitted;
    }
    const finalEvent = dispatch(eventName, dataLines);
    if (finalEvent && !signal.aborted) yield finalEvent;
  } finally {
    if (!streamCompleted) {
      try {
        await reader.cancel();
      } catch {
        // The transport may already have closed the stream.
      }
    }
    reader.releaseLock();
  }
}

interface ProcessedLine {
  readonly eventName: string;
  readonly dataLines: string[];
  readonly emitted?: ChatCompletionsSseEvent;
}

function processLine(line: string, eventName: string, dataLines: readonly string[]): ProcessedLine {
  if (line.length === 0) {
    return { eventName: "", dataLines: [], emitted: dispatch(eventName, dataLines) };
  }
  if (line.startsWith(":")) return { eventName, dataLines: [...dataLines] };
  const separator = line.indexOf(":");
  const field = separator < 0 ? line : line.slice(0, separator);
  const rawValue = separator < 0 ? "" : line.slice(separator + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  if (field === "event") return { eventName: value, dataLines: [...dataLines] };
  if (field === "data") return { eventName, dataLines: [...dataLines, value] };
  return { eventName, dataLines: [...dataLines] };
}

function dispatch(
  eventName: string,
  dataLines: readonly string[],
): ChatCompletionsSseEvent | undefined {
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  return { event: eventName, data };
}

function takeLine(buffer: string): { readonly value: string; readonly rest: string } | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character !== "\n" && character !== "\r") continue;
    if (character === "\r" && index + 1 === buffer.length) return undefined;
    const lineEnd = character === "\r" && buffer[index + 1] === "\n" ? index + 2 : index + 1;
    return { value: buffer.slice(0, index), rest: buffer.slice(lineEnd) };
  }
  return undefined;
}
