import type { z } from 'zod';

import type { AltegioClient } from '../client.js';
import type { Config } from '../config.js';

export interface ToolContext {
  readonly client: AltegioClient;
  readonly config: Config;
}

/** What a tool handler returns; `server.ts` renders it as MCP text content. */
export interface ToolOutput {
  /** Short guidance for the model, placed before the data. */
  readonly note?: string;
  /** JSON-serialisable data. */
  readonly data?: unknown;
}

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** `write` tools are registered only when ALTEGIO_ALLOW_WRITE=1. */
  readonly access: 'read' | 'write';
  readonly inputSchema: Schema;
  readonly annotations: ToolAnnotations;
  readonly handler: (args: z.infer<Schema>, context: ToolContext) => Promise<ToolOutput>;
}

/** A tool with its argument type erased, so tools with different schemas fit in one list. */
export type AnyTool = ToolDefinition<z.ZodObject>;

/** Identity helper that infers the handler's argument type from `inputSchema`. */
export function defineTool<Schema extends z.ZodObject>(tool: ToolDefinition<Schema>): AnyTool {
  return tool as unknown as AnyTool;
}

/** Every tool talks to an external service, hence `openWorldHint: true` everywhere. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Adds something that reaches a real person: a booking in a team member's
 * schedule, or a text message on a client's phone. Nothing existing is changed,
 * so the tools are not flagged destructive, and none is idempotent.
 */
export const ADDITIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Removes a booking from the schedule. */
export const DESTRUCTIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
