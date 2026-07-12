import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const DEFAULT_THREAD_ID = "default";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const textSchema = z.string().max(100_000);
const messageIdSchema = z.string().uuid();
const timestampSchema = z.number().int().nonnegative();

const envelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: messageIdSchema,
    sentAt: timestampSchema,
    correlationId: messageIdSchema.optional(),
  })
  .strict();

function messageSchema<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return envelopeSchema.extend({
    type: z.literal(type),
    payload,
  });
}

const permissionProfileSchema = z.enum([
  "read-only",
  "confirm-writes",
  "workspace-write",
  "autonomous",
]);

const agentRuntimeStateSchema = z.enum([
  "idle",
  "preparing-context",
  "building-prompt",
  "requesting-model",
  "waiting-for-approval",
  "executing-tools",
  "compacting-context",
  "reviewing-changes",
  "completed",
  "cancelled",
  "failed",
]);

const agentErrorCodeSchema = z.enum([
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_BAD_REQUEST",
  "MODEL_CONTEXT_EXCEEDED",
  "MODEL_TOOL_UNSUPPORTED",
  "INVALID_TOOL_INPUT",
  "TOOL_NOT_FOUND",
  "TOOL_EXECUTION_FAILED",
  "TOOL_PERMISSION_DENIED",
  "WORKSPACE_NOT_TRUSTED",
  "PATCH_CONFLICT",
  "FILE_OUTSIDE_WORKSPACE",
  "USER_CANCELLED",
  "AGENT_LIMIT_REACHED",
  "MODEL_NOT_FOUND",
  "MODEL_SELECTION_CONFLICT",
  "MODEL_SELECTION_BUSY",
  "MODEL_NOT_SELECTED",
]);

const threadEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user-message"),
      messageId: identifierSchema.optional(),
      text: textSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant-text"),
      messageId: identifierSchema.optional(),
      text: textSchema,
      streaming: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant-text-delta"),
      messageId: identifierSchema,
      delta: textSchema,
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-activity"),
      toolCallId: identifierSchema,
      name: identifierSchema,
      status: z.enum([
        "queued",
        "approval-required",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ]),
      summary: z.string().max(4_000),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: agentErrorCodeSchema,
      message: z.string().max(4_000),
    })
    .strict(),
]);

const proposedActionSummarySchema = z
  .object({
    kind: z.enum(["tool", "command", "file-change"]),
    summary: z.string().max(4_000),
    toolName: identifierSchema.optional(),
  })
  .strict();

const changeSetStatusSchema = z.enum(["pending", "approved", "applied", "discarded", "conflict"]);
const changeFileSummarySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    summary: z.string().max(4_000),
  })
  .strict();
const modelSummarySchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(256),
    provider: identifierSchema,
  })
  .strict();

export const uiToExtensionMessageSchema = z.discriminatedUnion("type", [
  messageSchema(
    "ui-ready",
    z
      .object({
        clientInstanceId: messageIdSchema,
        supportedProtocolVersions: z.array(z.literal(PROTOCOL_VERSION)).min(1).max(8),
      })
      .strict(),
  ),
  messageSchema(
    "send-message",
    z
      .object({
        threadId: identifierSchema,
        text: textSchema,
      })
      .strict(),
  ),
  messageSchema(
    "cancel-run",
    z
      .object({
        runId: identifierSchema,
      })
      .strict(),
  ),
  messageSchema(
    "approve-tool",
    z
      .object({
        approvalId: identifierSchema,
      })
      .strict(),
  ),
  messageSchema(
    "reject-tool",
    z
      .object({
        approvalId: identifierSchema,
        reason: z.string().max(2_000).optional(),
      })
      .strict(),
  ),
  messageSchema(
    "apply-change-set",
    z
      .object({
        changeSetId: identifierSchema,
      })
      .strict(),
  ),
  messageSchema(
    "discard-change-set",
    z
      .object({
        changeSetId: identifierSchema,
      })
      .strict(),
  ),
  messageSchema(
    "select-model",
    z
      .object({
        threadId: identifierSchema,
        modelId: identifierSchema,
        expectedThreadRevision: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  messageSchema(
    "set-permission",
    z
      .object({
        profile: permissionProfileSchema,
      })
      .strict(),
  ),
  messageSchema(
    "request-thread-snapshot",
    z
      .object({
        threadId: identifierSchema,
      })
      .strict(),
  ),
]);

export const extensionToUiMessageSchema = z.discriminatedUnion("type", [
  messageSchema(
    "host-ready",
    z
      .object({
        clientInstanceId: messageIdSchema,
        protocolVersion: z.literal(PROTOCOL_VERSION),
      })
      .strict(),
  ),
  messageSchema(
    "thread-snapshot",
    z
      .object({
        threadId: identifierSchema,
        revision: z.number().int().nonnegative(),
        events: z.array(threadEventSchema).max(1_000),
      })
      .strict(),
  ),
  messageSchema(
    "thread-event",
    z
      .object({
        threadId: identifierSchema,
        sequence: z.number().int().positive(),
        event: threadEventSchema,
      })
      .strict(),
  ),
  messageSchema(
    "run-state",
    z
      .object({
        runId: identifierSchema,
        threadId: identifierSchema,
        state: agentRuntimeStateSchema,
        sequence: z.number().int().positive(),
      })
      .strict(),
  ),
  messageSchema(
    "approval-requested",
    z
      .object({
        approvalId: identifierSchema,
        action: proposedActionSummarySchema,
        expiresAt: timestampSchema.optional(),
      })
      .strict(),
  ),
  messageSchema(
    "change-set-updated",
    z
      .object({
        changeSetId: identifierSchema,
        status: changeSetStatusSchema,
        files: z.array(changeFileSummarySchema).max(1_000),
      })
      .strict(),
  ),
  messageSchema(
    "model-list",
    z
      .object({
        threadId: identifierSchema,
        threadRevision: z.number().int().nonnegative(),
        models: z.array(modelSummarySchema).max(256),
        selectedModelId: identifierSchema.optional(),
      })
      .strict(),
  ),
  messageSchema(
    "permission-updated",
    z
      .object({
        profile: permissionProfileSchema,
      })
      .strict(),
  ),
  messageSchema(
    "protocol-error",
    z
      .object({
        code: z.enum(["UNSUPPORTED_VERSION", "INVALID_MESSAGE", "MESSAGE_TOO_LARGE"]),
        message: z.string().max(1_000),
        rejectedMessageId: messageIdSchema.optional(),
      })
      .strict(),
  ),
  messageSchema(
    "error",
    z
      .object({
        code: agentErrorCodeSchema,
        message: z.string().max(4_000),
        retryable: z.boolean(),
      })
      .strict(),
  ),
]);

export type PermissionProfile = z.infer<typeof permissionProfileSchema>;
export type AgentRuntimeState = z.infer<typeof agentRuntimeStateSchema>;
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type ProposedActionSummary = z.infer<typeof proposedActionSummarySchema>;
export type ChangeSetStatus = z.infer<typeof changeSetStatusSchema>;
export type ChangeFileSummary = z.infer<typeof changeFileSummarySchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type UiToExtensionMessage = z.infer<typeof uiToExtensionMessageSchema>;
export type ExtensionToUiMessage = z.infer<typeof extensionToUiMessageSchema>;
export type ModelListPayload = Extract<ExtensionToUiMessage, { type: "model-list" }>["payload"];

export type UiToExtensionMessageType = UiToExtensionMessage["type"];
export type ExtensionToUiMessageType = ExtensionToUiMessage["type"];
export type UiToExtensionPayload<TType extends UiToExtensionMessageType> = {
  [TKey in UiToExtensionMessageType]: Extract<UiToExtensionMessage, { type: TKey }>["payload"];
}[TType];
export type ExtensionToUiPayload<TType extends ExtensionToUiMessageType> = {
  [TKey in ExtensionToUiMessageType]: Extract<ExtensionToUiMessage, { type: TKey }>["payload"];
}[TType];

export interface MessageOptions {
  readonly correlationId?: string;
  readonly messageId?: string;
  readonly sentAt?: number;
}

export function createMessageId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // Message IDs are for correlation and de-duplication, never authentication.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUiToExtensionMessage<TType extends UiToExtensionMessageType>(
  type: TType,
  payload: UiToExtensionPayload<TType>,
  options: MessageOptions = {},
): UiToExtensionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: options.messageId ?? createMessageId(),
    type,
    sentAt: options.sentAt ?? Date.now(),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    payload,
  } as UiToExtensionMessage;
}

export function createExtensionToUiMessage<TType extends ExtensionToUiMessageType>(
  type: TType,
  payload: ExtensionToUiPayload<TType>,
  options: MessageOptions = {},
): ExtensionToUiMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: options.messageId ?? createMessageId(),
    type,
    sentAt: options.sentAt ?? Date.now(),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    payload,
  } as ExtensionToUiMessage;
}

export function parseUiToExtensionMessage(value: unknown): UiToExtensionMessage | undefined {
  if (!isWithinMessageSize(value)) {
    return undefined;
  }

  const result = uiToExtensionMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseExtensionToUiMessage(value: unknown): ExtensionToUiMessage | undefined {
  if (!isWithinMessageSize(value)) {
    return undefined;
  }

  const result = extensionToUiMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function isWithinMessageSize(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return false;
    }

    return new TextEncoder().encode(serialized).byteLength <= MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

export function getMessageId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.messageId !== "string") {
    return undefined;
  }

  return messageIdSchema.safeParse(value.messageId).success ? value.messageId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
