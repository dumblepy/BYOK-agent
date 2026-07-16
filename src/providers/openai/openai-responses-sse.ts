import type { ResponsesSseEvent } from "./openai-responses-types";

export class ResponsesSsePayloadTooLargeError extends Error {
  public override readonly name = "ResponsesSsePayloadTooLargeError";
}

/** Parses HTTP Server-Sent Events without assuming network chunks are event boundaries. */
export async function* parseResponsesSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
): AsyncIterable<ResponsesSseEvent> {
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
      if (bytesRead > maxBytes) throw new ResponsesSsePayloadTooLargeError();
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const line = takeLine(buffer);
        if (!line) break;
        buffer = line.rest;
        const event = processLine(line.value, state(eventName, dataLines));
        eventName = event.eventName;
        dataLines = event.dataLines;
        if (event.emitted && !signal.aborted) yield event.emitted;
      }
    }

    if (buffer.length > 0) {
      const event = processLine(buffer, state(eventName, dataLines));
      eventName = event.eventName;
      dataLines = event.dataLines;
      if (event.emitted && !signal.aborted) yield event.emitted;
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

interface SseState {
  readonly eventName: string;
  readonly dataLines: string[];
}

interface ProcessedLine {
  readonly eventName: string;
  readonly dataLines: string[];
  readonly emitted?: ResponsesSseEvent;
}

function state(eventName: string, dataLines: readonly string[]): SseState {
  return { eventName, dataLines: [...dataLines] };
}

function processLine(line: string, current: SseState): ProcessedLine {
  if (line.length === 0) {
    return {
      eventName: "",
      dataLines: [],
      emitted: dispatch(current.eventName, current.dataLines),
    };
  }
  if (line.startsWith(":")) return current;

  const separator = line.indexOf(":");
  const field = separator < 0 ? line : line.slice(0, separator);
  const rawValue = separator < 0 ? "" : line.slice(separator + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  if (field === "event") return { eventName: value, dataLines: current.dataLines };
  if (field === "data")
    return { eventName: current.eventName, dataLines: [...current.dataLines, value] };
  return current;
}

function dispatch(eventName: string, dataLines: readonly string[]): ResponsesSseEvent | undefined {
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return { event: "done", data };
  return { event: eventName || inferEventName(data), data };
}

function inferEventName(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (isRecord(parsed) && typeof parsed.type === "string") return parsed.type;
  } catch {
    // The event normalizer will report malformed JSON as a Provider error.
  }
  return "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
