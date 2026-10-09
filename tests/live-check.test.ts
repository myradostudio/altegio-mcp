/**
 * The live check itself, run as the command a person runs: scripts/live-check.mjs
 * is started as a child process and finds, through ALTEGIO_API_URL, a local
 * stand-in instead of api.alteg.io. The stand-in keeps a small location and
 * applies the filters it is sent, so the run passes; each rule of the script then
 * gets a case in which the run has to fail, or in which something must not be
 * sent or must not appear in the output.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import { json, ok, refusal, type FakeApi } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS, RECORD_HASH } from './support/fixtures.js';
import { serve } from './support/http-bridge.js';
import { DAYS, liveWorld, SMS_CODE } from './support/live-world.js';
import { assertMatchesSpec } from './support/spec.js';

// Compiled to build-test/tests/live-check.test.js; the script and the server build are two levels up.
const SCRIPT = fileURLToPath(new URL('../../scripts/live-check.mjs', import.meta.url));

const TOKEN = 'live-check-partner-token-do-not-print';
const TYPED_PHONE = '+380 (50) 123-45-67';
const PHONE = '+380501234567';
/** Everything the script would otherwise ask for. */
const KNOWN = { ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_LOCATION_ID: String(IDS.location), ALTEGIO_FORM_ID: String(IDS.form) };
/** The checks of a run without --write. A check that silently disappears changes this number. */
const READ_CHECKS = 21;
const WRITE_CHECKS = 4;
/** The slot the script picks: the last one of the last free day. */
const SLOT = `${DAYS.at(-1)}T18:30:00.000+03:00`;

interface Run {
  readonly code: number | null;
  /** stdout and stderr together: nothing secret may be in either. */
  readonly output: string;
  readonly lines: readonly string[];
}

/** Runs the script against the stand-in. `input` is what the person would type, one answer per line. */
async function liveCheck(api: FakeApi, args: string[] = [], options: { input?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const bridge = await serve(api);
  try {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...getDefaultEnvironment(), ALTEGIO_API_URL: bridge.url, ...(options.env ?? KNOWN) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (output += chunk));
    }
    child.stdin.end(options.input ?? '');
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    return { code, output, lines: output.split('\n').filter((line) => line !== '') };
  } finally {
    await bridge.close();
  }
}

const marked = (run: Run, mark: string) => run.lines.filter((line) => line.startsWith(`${mark}  `));
const sent = (api: FakeApi) => api.requests.map((request) => `${request.method} ${request.url.pathname}`);
const sentTo = (api: FakeApi, method: string, path: RegExp) => api.requests.filter((request) => request.method === method && path.test(request.url.pathname));

describe('live check against a stand-in for the API', { concurrency: true }, () => {
  it('passes without --write: PASS lines only, exit code 0, nothing but documented reads is sent', async () => {
    const { api, bookings } = liveWorld();
    const run = await liveCheck(api);

    assert.equal(run.code, 0, run.output);
    assert.match(run.lines[0] ?? '', /^Altegio live check, \d{4}-\d{2}-\d{2}, location 4564, read tools only, nothing is created$/);
    assert.equal(run.lines[1], 'PASS  the server offers the 9 read tools and no write tool — read-only');
    assert.equal(marked(run, 'PASS').length, READ_CHECKS, run.output);
    assert.deepEqual(marked(run, 'FAIL'), []);
    assert.deepEqual(marked(run, 'SKIP'), []);
    assert.equal(run.lines.at(-1), 'All checks passed.');

    // Reads only: GET, and the one POST Altegio documents for validating a booking.
    assert.deepEqual(
      [...new Set(api.requests.map((request) => (request.method === 'GET' ? 'GET' : `${request.method} ${request.url.pathname}`)))],
      ['GET', 'POST /api/v1/book_check/4564'],
    );
    assert.equal(bookings.length, 0);
    // Every request is one the documents describe, with the token and nothing else in the header.
    for (const request of api.requests) {
      assertMatchesSpec(request);
      assert.equal(request.headers['authorization'], `Bearer ${TOKEN}`);
    }
    // The refusal of another location is the server's own: no request names it.
    assert.ok(api.requests.every((request) => !request.url.pathname.includes(String(IDS.location + 1))));
  });

  it('prints counts and field names, never the token or the names of people and services', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api);

    assert.ok(!run.output.includes(TOKEN), 'the token must not be printed');
    for (const name of [fixtures.location.title, fixtures.location.address, ...fixtures.staff.map((member) => member.name), ...fixtures.services.services.map((service) => service.title)]) {
      assert.ok(!run.output.includes(name), `the output holds a name from the account: ${name}`);
    }
    assert.match(run.output, /^PASS  list_staff: without filters — team members: 2; fields: id, name, specialization, bookable, /m);
    // The stand-in has two services with the same beginning in one category, so limit and offset are really tried.
    assert.match(run.output, /^PASS  list_services: search, category_id, limit, offset — services that match: 2; limit 1 with offset 0 and 1 gives two different ones$/m);
  });

  it('asks for whatever the environment does not give: the token hidden, then the location and the form', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api, [], { env: {}, input: `${TOKEN}\n${IDS.location}\n\n` });

    assert.equal(run.code, 0, run.output);
    assert.deepEqual(run.lines.slice(0, 3), [
      'Altegio partner token (input is hidden): ',
      'Location id, the number of the branch in Altegio: ',
      'Booking form id, the number in the widget address https://bNNN.alteg.io (Enter to skip): ',
    ]);
    assert.ok(api.requests.length > 0 && api.requests.every((request) => request.headers['authorization'] === `Bearer ${TOKEN}`));
    assert.ok(!run.output.includes(TOKEN), 'the token must not be printed');
    // No form id: the tool that needs one is reported as skipped, and the last line says so.
    assert.deepEqual(marked(run, 'SKIP'), ['SKIP  get_booking_form: form_id — no booking form id was given']);
    assert.equal(marked(run, 'PASS').length, READ_CHECKS - 1);
    assert.equal(run.lines.at(-1), 'All checks that ran passed; 1 skipped, see the SKIP lines.');
    assert.ok(!sent(api).some((line) => line.includes('/bookform/')));
  });

  it('fails with exit code 1 when the API does not apply a filter', async () => {
    const { api } = liveWorld();
    // Every day, whatever month or period was asked for.
    api.on('GET', `/api/v1/book_dates/${IDS.location}`, ok({ booking_dates: DAYS, working_dates: DAYS }));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    const failed = marked(run, 'FAIL');
    assert.equal(failed.length, 2, run.output);
    assert.match(failed[0] ?? '', /^FAIL  list_available_dates: month — \d+ of 35 dates are outside the month that was asked for$/);
    // 28 of the 35 days lie outside the week, in both lists of the answer.
    assert.equal(failed[1], 'FAIL  list_available_dates: date_from, date_to — 56 dates are outside the period that was asked for');
    assert.equal(run.lines.at(-1), '2 check(s) failed.');
  });

  it('prints a refusal of the API in its words, without the token it repeats', async () => {
    const { api } = liveWorld();
    api.on('GET', `/api/v1/book_dates/${IDS.location}`, (request) => refusal(403, `No access for ${request.headers['authorization']}`));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    assert.match(run.output, /^FAIL  list_available_dates: service_ids, staff_id — Altegio API error \(HTTP 403\): No access for Bearer \[redacted\]$/m);
    assert.ok(!run.output.includes(TOKEN), 'the token must not be printed');
    // What needed a free day is skipped, not failed a second time.
    assert.ok(marked(run, 'SKIP').length >= 8, run.output);
    assert.match(run.lines.at(-1) ?? '', /^1 check\(s\) failed, \d+ skipped\.$/);
  });

  it('stops at once when Altegio rejects the token', async () => {
    const { api } = liveWorld();
    api.on('GET', /./, refusal(401, 'Unauthorized'));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    assert.deepEqual(marked(run, 'FAIL'), ['FAIL  get_location: location_id — Altegio API error (HTTP 401): Unauthorized']);
    assert.match(run.output, /Altegio rejected the partner token\. Check ALTEGIO_PARTNER_TOKEN\./);
    assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
    assert.equal(api.requests.length, 1, 'nothing more is sent with a rejected token');
    assert.equal(run.lines.at(-1), '1 check(s) failed.');
  });

  it('stops as well when the token is rejected in the middle of a run', async () => {
    const { api } = liveWorld();
    api.on('GET', `/api/v1/book_staff/${IDS.location}`, refusal(401, 'Unauthorized'));
    const run = await liveCheck(api);

    assert.equal(run.code, 1);
    assert.deepEqual(marked(run, 'FAIL'), ['FAIL  list_staff: without filters — Altegio API error (HTTP 401): Unauthorized']);
    assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
    assert.equal(sent(api).at(-1), 'GET /api/v1/book_staff/4564', 'nothing more is sent');
    assert.deepEqual(marked(run, 'SKIP'), [], 'the rest is not reported as skipped either: it was not run');
  });

  it('stops when the location does not answer to the token', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api, [], { env: { ...KNOWN, ALTEGIO_LOCATION_ID: String(IDS.otherLocation) } });

    assert.equal(run.code, 1);
    assert.equal(marked(run, 'FAIL').length, 1);
    assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
    assert.equal(api.requests.length, 1);
  });

  it('explains a token the server refuses to start with, without printing it', async () => {
    const { api } = liveWorld();
    const run = await liveCheck(api, [], { env: { ...KNOWN, ALTEGIO_PARTNER_TOKEN: 'two words' } });

    assert.equal(run.code, 1);
    assert.match(run.output, /The server did not start\./);
    assert.match(run.output, /ALTEGIO_PARTNER_TOKEN must be the partner token alone/);
    assert.ok(!run.output.includes('two words'));
    assert.equal(api.requests.length, 0);
  });

  describe('--write', () => {
    it('creates one booking for the phone that was typed, reads it back and cancels it', async () => {
      const { api, bookings, codesSentTo } = liveWorld();
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 0, run.output);
      assert.match(run.output, /^PASS  the server offers the 9 read tools and the 3 write tools — write tools: create_booking, send_phone_confirmation_code, cancel_booking$/m);
      assert.equal(marked(run, 'PASS').length, READ_CHECKS + WRITE_CHECKS, run.output);
      assert.deepEqual(marked(run, 'FAIL'), []);
      // The location of the stand-in does not confirm phones, so no SMS is asked for, and that is said.
      assert.deepEqual(marked(run, 'SKIP'), ['SKIP  send_phone_confirmation_code: client_phone — the location does not confirm phones by SMS']);
      assert.deepEqual(codesSentTo, []);
      assert.equal(run.lines.at(-1), 'All checks that ran passed; 1 skipped, see the SKIP lines.');

      // The slot is shown before the question, and nothing is created before the answer.
      const question = run.lines.findIndex((line) => line.startsWith('Type yes to create this booking and cancel it: '));
      assert.equal(run.lines[question - 2], `  when: ${DAYS.at(-1)} at 18:30, local time of the location`);
      assert.ok(question < run.lines.findIndex((line) => line.startsWith('PASS  create_booking')));

      assert.equal(bookings.length, 1);
      assert.equal(bookings[0]?.deleted, true, 'the booking is cancelled');
      const { api_id: externalId, ...body } = bookings[0]?.body ?? {};
      assert.match(externalId, /^live-check-\d+$/);
      assert.deepEqual(body, {
        phone: PHONE,
        fullname: 'MCP live check',
        comment: 'Created by the live check of altegio-mcp. It is cancelled right away; if you see it, delete it.',
        notify_by_sms: 0,
        notify_by_email: 0,
        appointments: [{ id: 1, services: [IDS.haircut], staff_id: IDS.staff, datetime: SLOT }],
      });
      const writes = sent(api).filter((line) => !line.startsWith('GET ') && !line.includes('/book_check/'));
      assert.deepEqual(writes, ['POST /api/v1/book_record/4564', `DELETE /api/v1/user/records/${IDS.record}/${RECORD_HASH}`]);
      for (const request of api.requests) assertMatchesSpec(request);

      // The phone and the hash that gives the right to cancel are not printed; the id of the booking is.
      for (const secret of [PHONE, TYPED_PHONE, '380501234567', '0501234567', RECORD_HASH, TOKEN]) {
        assert.ok(!run.output.includes(secret), `the output holds ${secret}`);
      }
      assert.match(run.output, new RegExp(`^PASS  create_booking: every argument but the e-mail — booking ${IDS.record} created$`, 'm'));
      assert.ok(!run.output.includes('!!!'));
    });

    it('at a location that confirms phones, sends the code, asks for it and books with it', async () => {
      const { api, bookings, codesSentTo } = liveWorld({ phoneConfirmation: true });
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n${SMS_CODE}\n` });

      assert.equal(run.code, 0, run.output);
      assert.deepEqual(codesSentTo, [PHONE]);
      assert.equal(bookings[0]?.body['code'], SMS_CODE);
      assert.equal(bookings[0]?.deleted, true);
      assert.equal(marked(run, 'PASS').length, READ_CHECKS + WRITE_CHECKS + 1);
      assert.match(run.output, /^Code from the SMS \(input is hidden\): $/m);
      assert.ok(!run.output.includes(SMS_CODE), 'the code must not be printed');
      assert.equal(run.lines.at(-1), 'All checks passed.');
      for (const request of api.requests) assertMatchesSpec(request);
    });

    it('hides the SMS code when Altegio refuses it and repeats it, and leaves no booking behind', async () => {
      const { api, bookings } = liveWorld({ phoneConfirmation: true });
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n551234\n` });

      assert.equal(run.code, 1);
      assert.match(run.output, /^FAIL  create_booking: every argument but the e-mail — Altegio API error \(HTTP 422\): An error has occurred$/m);
      assert.match(run.output, /^ {6} {2}- code 432: The SMS code \[hidden\] is wrong$/m);
      assert.ok(!run.output.includes('551234'), 'the code must not be printed');
      assert.equal(bookings.length, 0);
      assert.ok(!run.output.includes('!!!'), 'a definite refusal leaves nothing to delete by hand');
    });

    it('creates nothing unless the answer is yes', async () => {
      const { api, bookings } = liveWorld();
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nno\n` });

      assert.equal(run.code, 0, run.output);
      assert.deepEqual(marked(run, 'SKIP'), ['SKIP  create_booking, get_booking, cancel_booking — not confirmed, nothing was created']);
      assert.equal(bookings.length, 0);
      assert.deepEqual(sentTo(api, 'POST', /book_record|book_code/), []);
      assert.deepEqual(sentTo(api, 'DELETE', /./), []);
    });

    it('says which booking to delete by hand when the cancellation is refused: exit code 1', async () => {
      const { api, bookings } = liveWorld();
      api.on('DELETE', /user\/records/, refusal(403, 'Deleting appointments is forbidden'));
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 1);
      assert.equal(bookings[0]?.deleted, false);
      assert.deepEqual(
        marked(run, 'FAIL').map((line) => line.split(' — ')[0]),
        ['FAIL  cancel_booking: record_id, record_hash', 'FAIL  get_booking: after the cancellation the booking is gone'],
      );
      assert.match(run.output, /Altegio API error \(HTTP 403\): Deleting appointments is forbidden/);
      assert.deepEqual(run.lines.slice(-3), [
        '!!! The test booking was NOT cancelled, or its cancellation could not be confirmed.',
        `!!! Location 4564, ${DAYS.at(-1)} at 18:30, client "MCP live check", booking ${IDS.record}: look it up in Altegio and delete it by hand.`,
        '2 check(s) failed, 1 skipped.',
      ]);
    });

    it('cancels the booking even when reading it back fails', async () => {
      const { api, bookings } = liveWorld();
      let reads = 0;
      api.on('GET', new RegExp(`/book_record/${IDS.location}/${IDS.record}/`), () => {
        reads += 1;
        // The read right after the creation fails; the one after the cancellation is answered.
        return reads === 1 ? json({ message: 'Bad gateway' }, 502) : json({ ...fixtures.booking, id: IDS.record, deleted: bookings[0]?.deleted });
      });
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 1);
      assert.deepEqual(
        marked(run, 'FAIL').map((line) => line.split(' — ')[0]),
        ['FAIL  get_booking: the booking that was just made'],
      );
      assert.equal(bookings[0]?.deleted, true, 'the booking is cancelled all the same');
      assert.match(run.output, /^PASS  get_booking: after the cancellation the booking is gone — marked as deleted$/m);
      assert.ok(!run.output.includes('!!!'), 'nothing is left to delete by hand');
    });

    it('cancels the booking even when the run is stopped right after it was created', async () => {
      const { api, bookings } = liveWorld();
      // The rate limit of Altegio ends the run at the first read of the new booking.
      api.on('GET', new RegExp(`/book_record/${IDS.location}/${IDS.record}/`), refusal(429, 'Too many requests'));
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 1);
      assert.match(run.output, /^Stopped: the remaining checks were not run\.$/m);
      assert.equal(sent(api).at(-1), `DELETE /api/v1/user/records/${IDS.record}/${RECORD_HASH}`);
      assert.equal(bookings[0]?.deleted, true, 'the booking is cancelled all the same');
      // Cancelled, but the run ended before it could see that: the person is told to look.
      assert.match(run.output, new RegExp(`^!!! Location 4564, ${DAYS.at(-1)} at 18:30, client "MCP live check", booking ${IDS.record}: `, 'm'));
    });

    it('hides the phone when Altegio repeats it in a refusal', async () => {
      const { api } = liveWorld();
      api.on('POST', `/api/v1/book_record/${IDS.location}`, (request) =>
        refusal(422, 'An error has occurred', [{ code: 431, message: `The phone ${(request.body as Record<string, any>)['phone']} is not valid` }]),
      );
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 1);
      assert.match(run.output, /^ {6} {2}- code 431: The phone \[hidden\] is not valid$/m);
      for (const secret of [PHONE, '380501234567']) assert.ok(!run.output.includes(secret), `the output holds ${secret}`);
      assert.ok(!run.output.includes('!!!'), 'a definite refusal leaves no booking behind');
    });

    // A gateway error, and the rate limit of Altegio: after either nobody knows whether the booking was made.
    for (const status of [502, 429]) {
      it(`says that the booking may exist when its creation got no definite answer (HTTP ${status}), and sends nothing after it`, async () => {
        const { api } = liveWorld();
        api.on('POST', `/api/v1/book_record/${IDS.location}`, json({ message: 'No answer' }, status));
        const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

        assert.equal(run.code, 1);
        assert.match(run.output, new RegExp(`^FAIL  create_booking: every argument but the e-mail — Altegio API error \\(HTTP ${status}\\)`, 'm'));
        assert.match(run.output, /It is unknown whether Altegio carried out the operation/);
        assert.deepEqual(run.lines.slice(-3), [
          '!!! The test booking MAY EXIST: Altegio gave no definite answer when it was created.',
          `!!! Location 4564, ${DAYS.at(-1)} at 18:30, client "MCP live check", booking with an unknown id: look it up in Altegio and delete it by hand.`,
          '1 check(s) failed, 1 skipped.',
        ]);
        assert.equal(sent(api).at(-1), 'POST /api/v1/book_record/4564');
      });
    }

    it('names the booking when Altegio created it but sent no hash to cancel it with', async () => {
      const { api } = liveWorld();
      api.on('POST', `/api/v1/book_record/${IDS.location}`, ok([{ id: 1, record_id: IDS.record }], 201));
      const run = await liveCheck(api, ['--write'], { input: `${TYPED_PHONE}\nyes\n` });

      assert.equal(run.code, 1);
      assert.match(run.output, /^FAIL  create_booking: every argument but the e-mail — no record_id or record_hash came back: /m);
      assert.deepEqual(run.lines.slice(-3), [
        '!!! The test booking was NOT cancelled, or its cancellation could not be confirmed.',
        `!!! Location 4564, ${DAYS.at(-1)} at 18:30, client "MCP live check", booking ${IDS.record}: look it up in Altegio and delete it by hand.`,
        '1 check(s) failed, 1 skipped.',
      ]);
      assert.equal(sent(api).at(-1), 'POST /api/v1/book_record/4564');
    });
  });

  describe('a mistake in how the script is started ends it with exit code 2 before anything is sent', () => {
    const cases: [string, string[], Record<string, string>, string, RegExp][] = [
      ['an argument other than --write, which is not repeated: it may be a token', ['--token', TOKEN], KNOWN, '', /^The script takes only --write\./],
      ['no token', [], {}, '\n', /^No partner token was given/],
      ['a location id that is not a number', [], { ALTEGIO_PARTNER_TOKEN: TOKEN }, 'salon\n', /^The location id must be a number/],
      ['a form id that is not a number', [], { ...KNOWN, ALTEGIO_FORM_ID: 'b123' }, '', /^The booking form id must be a number/],
      ['--write with something that is not a phone', ['--write'], KNOWN, 'my phone\n', /^That is not a phone number/],
    ];
    for (const [name, args, env, input, message] of cases) {
      it(name, async () => {
        const { api } = liveWorld();
        const run = await liveCheck(api, args, { env, input });

        assert.equal(run.code, 2, run.output);
        assert.match(run.lines.at(-1) ?? '', message);
        assert.equal(api.requests.length, 0);
        assert.deepEqual(marked(run, 'PASS'), []);
        assert.ok(!run.output.includes(TOKEN));
      });
    }
  });

  describe('documentation', () => {
    const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

    for (const file of ['README.md', 'README.uk.md']) {
      it(`${file} names both live-check commands and no npm script that does not exist`, () => {
        const text = read(file);
        const named = [...text.matchAll(/npm run ([a-z:-]+)/g)].map((match) => match[1] ?? '');
        for (const name of named) assert.ok(name in scripts, `${file} names \`npm run ${name}\`, which package.json does not have`);
        for (const name of ['live-check', 'live-check:write']) assert.ok(named.includes(name), `${file} does not name \`npm run ${name}\``);
        for (const variable of ['ALTEGIO_FORM_ID', '--write']) assert.ok(text.includes(variable), `${file} does not name ${variable}`);
      });
    }

    it('the npm commands start the script with the arguments the documentation promises, and only one of them writes', () => {
      assert.equal(scripts['live-check'], 'npm run build && node scripts/live-check.mjs');
      assert.equal(scripts['live-check:write'], 'npm run build && node scripts/live-check.mjs --write');
    });
  });
});
