import { createProviderError } from "./provider-error";
import type { ProviderEvent } from "./provider-types";

interface PendingToolCall {
  readonly id: string;
  name: string;
  argumentsText: string;
}

export interface ToolCallAccumulatorResult {
  readonly events: readonly ProviderEvent[];
  readonly error?: ReturnType<typeof createProviderError>;
}

/**
 * Provider固有ストリームのTool Call断片をAdapter内で結合するための状態。
 * Agentへ渡すのは start/delta と、JSONが完成したときの tool-call だけにする。
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<string, PendingToolCall>();
  private readonly completed = new Set<string>();

  public start(id: string, name: string): ProviderEvent {
    if (id.length === 0 || name.length === 0 || this.calls.has(id) || this.completed.has(id)) {
      throw new Error("Invalid or duplicate tool call");
    }
    this.calls.set(id, { id, name, argumentsText: "" });
    return { type: "tool-call-start", id, name };
  }

  public append(id: string, argumentsDelta: string): ProviderEvent {
    const call = this.calls.get(id);
    if (!call || this.completed.has(id)) throw new Error("Unknown tool call");
    call.argumentsText += argumentsDelta;
    return { type: "tool-call-delta", id, argumentsDelta };
  }

  public complete(id: string): ProviderEvent {
    const call = this.calls.get(id);
    if (!call || this.completed.has(id)) throw new Error("Unknown or completed tool call");
    let args: unknown;
    try {
      args = JSON.parse(call.argumentsText);
    } catch {
      throw new Error("Tool call arguments are not valid JSON");
    }
    this.calls.delete(id);
    this.completed.add(id);
    return { type: "tool-call", id, name: call.name, arguments: args };
  }

  public finish(): ToolCallAccumulatorResult {
    if (this.calls.size === 0) return { events: [] };
    return {
      events: [],
      error: createProviderError("bad-request"),
    };
  }
}
