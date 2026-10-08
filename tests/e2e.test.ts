/**
 * End to end: the built server (dist/index.js) is started as a child process,
 * exactly as an MCP host starts it, and driven over stdio. The Altegio API is a
 * local HTTP server on 127.0.0.1, so nothing leaves the machine.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Compiled to build-test/tests/e2e.test.js; the server build is in dist/.
const SERVER_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const TOKEN = 'e2e-partner-token-do-not-log';

const READ_TOOLS = [
  'get_location',
  'get_booking_form',
  'list_services',
  'list_staff',
  'list_available_dates',
  'list_time_slots',
  'get_nearest_time_slots',
  'check_booking',
  'get_booking',
];
const WRITE_TOOLS = ['create_booking', 'send_phone_confirmation_code', 'cancel_booking'];

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

let api: Server;
let apiUrl: string;
const apiCalls: ApiCall[] = [];

before(async () => {
  api = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const path = request.url ?? '';
      apiCalls.push({ method: request.method ?? '', path, headers: request.headers, body });
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.method === 'GET' && path === '/api/v1/book_staff/4564?service_ids%5B%5D=331') {
        reply(200, {
          success: true,
          data: [{ id: 6544, name: 'Олена', specialization: 'Перукар', bookable: true, avatar: 'https://example.com/a.png' }],
          meta: [],
        });
      } else if (request.method === 'POST' && path === '/api/v1/book_record/4564') {
        reply(201, { success: true, data: [{ id: 1, record_id: 2820023, record_hash: '567df655304da9b98487769426d4e76e' }], meta: [] });
      } else {
        reply(404, { success: false, data: null, meta: { message: 'Not found' } });
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => api.close(resolve));
});

function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ALTEGIO_PARTNER_TOKEN: TOKEN,
    ALTEGIO_LOCATION_ID: '4564',
    ALTEGIO_API_URL: apiUrl,
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe('stdio server process', () => {
  it('serves an MCP client: lists the read tools and calls one', async () => {
    apiCalls.length = 0;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: serverEnv(),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // "legacy" is the 2025-era handshake, spoken by every host that has not moved to the 2026 protocol.
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(transport);
    assert.match(client.getNegotiatedProtocolVersion() ?? '', /^2025-/);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), READ_TOOLS);
    assert.equal(apiCalls.length, 0, 'listing tools must not contact the API');

    const result = await client.callTool({ name: 'list_staff', arguments: { service_ids: [331] } });
    const content = result.content as { type: string; text: string }[];
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(content[0]!.text), {
      returned: 1,
      staff: [{ id: 6544, name: 'Олена', specialization: 'Перукар', bookable: true }],
    });

    const [call] = apiCalls;
    assert.equal(apiCalls.length, 1);
    assert.equal(`${call?.method} ${call?.path}`, 'GET /api/v1/book_staff/4564?service_ids%5B%5D=331');
    assert.equal(call?.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(call?.headers['accept'], 'application/vnd.api.v2+json');
    assert.match(String(call?.headers['user-agent']), /^altegio-mcp\/\d+\.\d+\.\d+$/);

    await client.close();

    assert.match(stderr, /\[altegio-mcp\] v\d+\.\d+\.\d+ listening on stdio; read-only; API http:\/\/127\.0\.0\.1:\d+; location 4564\./);
    assert.ok(!stderr.includes(TOKEN), 'the token must never be written to stderr');
  });

  it('adds the write tools when ALTEGIO_ALLOW_WRITE=1, also for a client of the 2026 protocol', async () => {
    apiCalls.length = 0;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: serverEnv({ ALTEGIO_ALLOW_WRITE: '1' }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // "auto" negotiates the newest protocol revision; the first test used the 2025-era handshake.
    const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);

    const protocolVersion = client.getNegotiatedProtocolVersion() ?? '';
    const { tools } = await client.listTools();
    const created = await client.callTool({
      name: 'create_booking',
      arguments: {
        client_name: 'Ірина Тестова',
        client_phone: '+380501234567',
        staff_id: 6544,
        datetime: '2026-10-12T15:30:00.000+03:00',
        service_ids: [331],
      },
    });
    await client.close();

    assert.ok(protocolVersion >= '2026-07-28', `negotiated ${protocolVersion}`);
    assert.deepEqual(tools.map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS]);
    assert.deepEqual(
      tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name),
      WRITE_TOOLS,
    );
    assert.notEqual(created.isError, true);
    assert.match((created.content as { text: string }[])[0]!.text, /^Altegio created booking 2820023\./);
    assert.deepEqual(
      apiCalls.map((call) => `${call.method} ${call.path}`),
      ['POST /api/v1/book_record/4564'],
    );
    assert.deepEqual(JSON.parse(apiCalls[0]!.body), {
      phone: '+380501234567',
      fullname: 'Ірина Тестова',
      appointments: [{ id: 1, services: [331], staff_id: 6544, datetime: '2026-10-12T15:30:00.000+03:00' }],
    });
    assert.match(stderr, /WRITE TOOLS ENABLED/);
    assert.ok(!stderr.includes('Тестова') && !stderr.includes('380501234567'), 'client data must never be written to stderr');
  });

  it('speaks plain JSON-RPC to a 2025-era client, keeps stdout clean and exits when stdin closes', async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], { env: serverEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-client', version: '1.0.0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const answered = await waitFor(() => stdout.split('\n').filter(Boolean).length >= 2, 10_000);
    assert.ok(answered, 'the server answered both requests');
    child.stdin.end();
    const exitCode = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5_000))]);
    if (exitCode === 'timeout') child.kill();

    const messages = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    assert.equal(messages.length, 2, 'stdout carries protocol messages only');
    assert.equal(messages[0]?.id, 1);
    assert.equal(messages[0]?.result['protocolVersion'], '2025-06-18');
    assert.equal(messages[1]?.id, 2);
    assert.equal((messages[1]?.result['tools'] as unknown[]).length, READ_TOOLS.length);
    assert.equal(exitCode, 0, 'the process ends by itself once the client is gone');
  });

  it('refuses to start without a token: message on stderr, nothing on stdout, exit code 1', () => {
    const result = spawnSync(process.execPath, [SERVER_ENTRY], {
      env: { ...getDefaultEnvironment(), ALTEGIO_ALLOW_WRITE: 'maybe' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[altegio-mcp\] Invalid configuration:/);
    assert.match(result.stderr, /ALTEGIO_PARTNER_TOKEN is not set/);
    assert.match(result.stderr, /ALTEGIO_ALLOW_WRITE must be 1/);
  });
});
