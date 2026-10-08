/** Tool metadata, annotations, server instructions and error rendering. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { z } from 'zod';

import { AltegioClient } from '../src/client.js';
import { runTool, selectTools } from '../src/server.js';
import { defineTool, READ_ONLY } from '../src/tools/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';
import { FakeApi, ok, refusal } from './support/fake-api.js';
import { IDS, RECORD_HASH, SLOT } from './support/fixtures.js';
import { createHarness, PARTNER_TOKEN, testConfig, type Harness } from './support/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('server metadata', () => {
  it('introduces itself with its name, version and read-only instructions', async () => {
    harness = await createHarness();

    assert.deepEqual(
      { name: harness.mcp.getServerVersion()?.name, version: harness.mcp.getServerVersion()?.version },
      { name: SERVER_NAME, version: SERVER_VERSION },
    );
    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /Unofficial/);
    assert.match(instructions, /in seconds/);
    assert.match(instructions, /bound to location 4564/);
    assert.match(instructions, /read-only mode/);
    assert.doesNotMatch(instructions, /Write tools are enabled/);
  });

  it('asks for confirmation in the instructions when write tools are enabled', async () => {
    harness = await createHarness({ allowWrite: true, locationId: undefined });

    const instructions = harness.mcp.getInstructions() ?? '';
    assert.match(instructions, /Write tools are enabled/);
    assert.match(instructions, /explicit confirmation from the user/);
    assert.match(instructions, /No location is preset/);
  });

  it('describes every tool: unique snake_case name, title, description, object schema', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z]+(_[a-z]+)+$/, tool.name);
      assert.ok((tool.title ?? '').length > 0, `${tool.name}: title`);
      assert.ok((tool.description ?? '').length >= 80, `${tool.name}: description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: input schema`);
    }
  });

  it('documents every argument of every tool', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, property] of Object.entries(properties)) {
        assert.ok((property.description ?? '').length > 0, `${tool.name}.${name} has no description`);
      }
    }
  });
});

describe('annotations', () => {
  it('marks read tools as read-only and idempotent', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();

    assert.equal(tools.length, 9);
    for (const tool of tools) {
      assert.deepEqual(
        tool.annotations,
        { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        tool.name,
      );
    }
  });

  it('marks creating a booking and sending a code as writes that add, and cancelling as destructive', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();
    const annotations = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      return { ...tool?.annotations, title: undefined };
    };

    const additive = { title: undefined, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    assert.deepEqual(annotations('create_booking'), additive);
    assert.deepEqual(annotations('send_phone_confirmation_code'), additive);
    assert.deepEqual(annotations('cancel_booking'), { ...additive, destructiveHint: true });
  });

  it('read tools send GET only, except the documented validation request of check_booking', async () => {
    // Guards the read-only promise at the source: a read tool that sends another POST fails here.
    const api = new FakeApi();
    api.on('GET', /.*/, ok({}));
    api.on('GET', /book_staff\/|book_times\//, ok([]));
    api.on('POST', /.*/, ok(null, 201));
    harness = await createHarness({}, api);
    const sampleArguments: Record<string, Record<string, unknown>> = {
      get_booking_form: { form_id: IDS.form },
      list_time_slots: { staff_id: IDS.staff, date: '2026-10-12' },
      get_nearest_time_slots: { staff_id: IDS.staff },
      check_booking: { staff_id: IDS.staff, datetime: SLOT, service_ids: [IDS.haircut] },
      get_booking: { record_id: IDS.record, record_hash: RECORD_HASH },
    };

    for (const tool of selectTools(testConfig())) {
      const result = await harness.call(tool.name, sampleArguments[tool.name] ?? {});
      assert.equal(result.isError, false, `${tool.name}: ${result.text}`);
    }

    assert.equal(api.requests.length, 9);
    const notGet = api.requests.filter((request) => request.method !== 'GET');
    assert.deepEqual(
      notGet.map((request) => `${request.method} ${request.url.pathname}`),
      ['POST /api/v1/book_check/4564'],
    );
  });
});

describe('booking warnings', () => {
  it('write tools say what they cause in the real world', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';

    assert.match(description('create_booking'), /takes real time in a team member's schedule/);
    assert.match(description('create_booking'), /explicit confirmation/);
    assert.match(description('send_phone_confirmation_code'), /goes to a real person/);
    assert.match(description('cancel_booking'), /cannot be undone/);
  });
});

describe('error rendering', () => {
  it('returns API errors as isError results with the API message', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/locations/4564', refusal(403, 'Немає доступу до філії'));

    const result = await harness.call('get_location');

    assert.equal(result.isError, true);
    assert.match(result.text, /^Altegio API error \(HTTP 403\): Немає доступу до філії\n/);
    assert.ok(!result.text.includes(PARTNER_TOKEN));
  });

  it('never exposes a stack trace, whatever a handler throws', async () => {
    const config = testConfig();
    const context = { config, client: new AltegioClient({ config, fetch: new FakeApi().fetch }) };
    const failing = (thrown: unknown) =>
      defineTool({
        name: 'failing_tool',
        title: 'Failing tool',
        description: 'Always fails.',
        access: 'read',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        handler: async () => {
          throw thrown;
        },
      });

    const fromError = await runTool(failing(new TypeError("Cannot read properties of undefined (reading 'x')")), {}, context);
    const fromString = await runTool(failing('plain string'), {}, context);

    assert.deepEqual(fromError, {
      content: [{ type: 'text', text: "Cannot read properties of undefined (reading 'x')" }],
      isError: true,
    });
    assert.deepEqual(fromString, { content: [{ type: 'text', text: 'Unexpected error.' }], isError: true });
    assert.doesNotMatch(JSON.stringify(fromError), /\bat .*\.js/);
  });
});
