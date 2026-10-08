/**
 * Builds the MCP server: picks the tools allowed by the configuration and wires
 * each one to the SDK with uniform result rendering and error handling.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';

import type { AltegioClient } from './client.js';
import type { Config } from './config.js';
import { describeError } from './errors.js';
import { readTools } from './tools/read.js';
import type { AnyTool, ToolContext, ToolOutput } from './tools/types.js';
import { writeTools } from './tools/write.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface ServerDependencies {
  readonly config: Config;
  readonly client: AltegioClient;
}

const READ_ONLY_MODE =
  'This server runs in read-only mode: it cannot create or cancel bookings or send SMS codes. If the user asks for that, explain that the operator has to start the server with ALTEGIO_ALLOW_WRITE=1.';

const WRITE_MODE =
  'Write tools are enabled. A booking takes real time in a schedule and may trigger notifications to the client and the business. Never create or cancel one on your own initiative: state exactly what will be booked (service, team member, date, time, client name and phone) and get explicit confirmation from the user first.';

function instructions(config: Config): string {
  return [
    'Unofficial MCP server for Altegio (alteg.io), an online booking system for salons, clinics and other service businesses. It uses the public online booking API with a partner token, so it sees what a booking widget sees: services, team members and free time, not the schedule or the client base.',
    'Usual order: list_services, list_staff for the chosen services, list_available_dates, list_time_slots, check_booking, and only then create_booking. Pass the `datetime` of a slot on unchanged.',
    'Ids are numbers. Durations (seance_length, sum_length) are in seconds. Prices are in the currency of the location. Slot times are local to the location; get_location returns its time zone.',
    config.locationId === undefined
      ? 'No location is preset: pass location_id to every tool that takes it.'
      : `The server is bound to location ${config.locationId}: location_id can be omitted and no other location is accepted.`,
    config.allowWrite ? WRITE_MODE : READ_ONLY_MODE,
  ].join('\n');
}

/** Read tools always; write tools only when the operator opted in. */
export function selectTools(config: Config): readonly AnyTool[] {
  return config.allowWrite ? [...readTools, ...writeTools] : readTools;
}

function render(output: ToolOutput): CallToolResult {
  const parts: string[] = [];
  if (output.note !== undefined) parts.push(output.note);
  if (output.data !== undefined && output.data !== null) {
    parts.push(typeof output.data === 'string' ? output.data : JSON.stringify(output.data, null, 2));
  }
  if (parts.length === 0) parts.push('The Altegio API returned an empty response.');
  return { content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/** Runs a tool handler. Failures become `isError` results with a plain message, never a stack trace. */
export async function runTool(tool: AnyTool, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult> {
  try {
    return render(await tool.handler(args, context));
  } catch (error) {
    return { content: [{ type: 'text', text: describeError(error) }], isError: true };
  }
}

export function createServer({ config, client }: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Altegio online booking (unofficial)', version: SERVER_VERSION },
    { instructions: instructions(config) },
  );
  const context: ToolContext = { config, client };

  for (const tool of selectTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args) => runTool(tool, args, context),
    );
  }

  return server;
}
