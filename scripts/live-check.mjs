// Runs the tools of the built server against the real Altegio API.
//
// The unit tests replace the API with a stand-in; this script is the other half:
// it starts dist/index.js the way an MCP host does, bound to one location, and
// calls every read tool with every argument it has. What it needs to know about
// the location (a team member, a service, a free day, a slot) it takes from the
// answers themselves. It prints counts and field names, not the names of people
// or services.
//
// Usage:
//   npm run live-check          the read tools; nothing is created
//   npm run live-check:write    the same, then one test booking that is cancelled at once
//   node scripts/live-check.mjs [--write]
//
// What it asks for, unless the environment variable is set:
//   ALTEGIO_PARTNER_TOKEN   the partner token; the input is hidden
//   ALTEGIO_LOCATION_ID     the id of the location
//   ALTEGIO_FORM_ID         the id of a booking form of that location (the number in
//                           https://bNNN.alteg.io); Enter skips get_booking_form
//
// --write is never the default. It registers the write tools, asks for a phone of
// your own (hidden) and, after the read checks, shows the slot it chose and waits
// for "yes". Then it creates a booking for "MCP live check", reads it back and
// cancels it. If the cancellation fails, or cannot be confirmed, the last lines
// say which booking to delete by hand. At a location that confirms phones by SMS
// it also sends the code and asks for it.
//
// Nothing that is typed is echoed or printed, and the token goes to the server
// through its environment, not through a command line.
//
// It needs the network and a real account, so it is not part of `npm test` or of
// CI; the tests run this script against a local stand-in (tests/live-check.test.ts).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { createPrompter, createReporter, exitAfterOutput, expect, Interrupted, need, Stop } from './live-check-io.mjs';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

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

const CLIENT_NAME = 'MCP live check';
const COMMENT = 'Created by the live check of altegio-mcp. It is cancelled right away; if you see it, delete it.';
/** How a write tool of the server begins the sentence about a request that got no definite answer. */
const UNKNOWN_OUTCOME = 'It is unknown whether';
/** Shaped like a real hash, so that the API and not the tool is the one to refuse it. */
const MADE_UP_HASH = '00000000000000000000000000000000';

const ID = /^[1-9]\d{0,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const report = createReporter();
const prompt = createPrompter();

/** Ends the run before anything is sent: a mistake in how the script was started. */
async function refuse(message) {
  report.say(message);
  await exitAfterOutput(2);
}

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--write')) {
  // What was passed is not repeated: it may be a token put on the command line by mistake.
  await refuse('The script takes only --write. The token is never passed on the command line: the script asks for it.');
}
const write = flags.includes('--write');
if (!existsSync(SERVER_ENTRY)) await refuse('dist/index.js is missing. Run `npm run build` first, or start the check with `npm run live-check`.');

const fromEnv = (name) => (process.env[name] ?? '').trim();

let token = fromEnv('ALTEGIO_PARTNER_TOKEN');
let locationText = fromEnv('ALTEGIO_LOCATION_ID');
let formText = process.env.ALTEGIO_FORM_ID?.trim();
let phone;
try {
  if (token === '') token = await prompt.secret('Altegio partner token (input is hidden): ');
  if (token === '') await refuse('No partner token was given, so there is nothing to check with.');
  report.hide(token, token.replace(/^bearer\s+/i, ''));

  if (locationText === '') locationText = await prompt.line('Location id, the number of the branch in Altegio: ');
  if (!ID.test(locationText)) await refuse('The location id must be a number, for example 4564.');

  formText ??= await prompt.line('Booking form id, the number in the widget address https://bNNN.alteg.io (Enter to skip): ');
  if (formText !== '' && !ID.test(formText)) await refuse('The booking form id must be a number, for example 123.');

  if (write) {
    report.say('--write: after the read checks one booking is created in the schedule of the location and cancelled at once.');
    report.say('You will see the slot and be asked to confirm. Altegio may notify the business and message the phone you give.');
    phone = (await prompt.secret('Phone for the test booking, your own, in international format (input is hidden): ')).replace(/[\s()-]/g, '');
    if (!/^\+?\d{9,15}$/.test(phone)) await refuse('That is not a phone number: 9 to 15 digits are expected, for example +380501234567.');
    const digits = phone.replace(/\D/g, '');
    report.hide(phone, digits, digits.slice(-10), digits.slice(-9));
  }
} catch (error) {
  if (error instanceof Interrupted) process.exit(130);
  throw error;
}
const locationId = Number(locationText);
const formId = formText === '' ? undefined : Number(formText);

const env = { ...getDefaultEnvironment(), ALTEGIO_PARTNER_TOKEN: token, ALTEGIO_LOCATION_ID: locationText };
if (process.env.ALTEGIO_API_URL) env.ALTEGIO_API_URL = process.env.ALTEGIO_API_URL;
if (write) env.ALTEGIO_ALLOW_WRITE = '1';

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: 'pipe' });
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog += chunk));
const client = new Client({ name: 'live-check', version: '1.0.0' });
try {
  await client.connect(transport);
} catch (error) {
  // A token with a space in it, for example: the server explains on stderr why it refused to start.
  report.say('The server did not start.');
  report.say(serverLog.trim() || (error instanceof Error ? error.message : String(error)));
  await exitAfterOutput(1);
}

const firstLine = (text) => text.split('\n')[0];

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const isError = result.isError === true;
  // With a rejected token or a used-up rate every further line would be the same failure. A write that got no
  // definite answer is left to its check: that one has to say that a booking may exist.
  if (isError && /^Altegio API error \(HTTP 401\)/.test(text)) throw new Stop(text);
  if (isError && !text.includes(UNKNOWN_OUTCOME) && (/^Altegio API error \(HTTP 429\)/.test(text) || text.startsWith('Not sent: '))) {
    throw new Stop(`${text}\nWait a minute and run the check again.`);
  }
  return {
    isError,
    text,
    /** The data of the answer; undefined when the tool returned a note alone. A refused call throws its refusal. */
    get json() {
      if (isError) throw new Error(text);
      const start = text.search(/^[{[]/m);
      return start === -1 ? undefined : JSON.parse(text.slice(start));
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const fieldsOf = (object) => Object.keys(object).join(', ');
const codesOf = (reasons) => (reasons ?? []).map((reason) => (reason.code === null ? 'no code' : `code ${reason.code}`)).join(', ');

report.say(
  `Altegio live check, ${today()}, location ${locationId}, ${write ? 'read tools and one test booking that is cancelled at once' : 'read tools only, nothing is created'}`,
);

/** A booking this run created and has not seen deleted yet. Whatever ends the run, the last lines name it. */
let leftover;

try {
  await report.check(write ? 'the server offers the 9 read tools and the 3 write tools' : 'the server offers the 9 read tools and no write tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const expected = write ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    expect(JSON.stringify(names) === JSON.stringify(expected), `the server offers ${names.join(', ')}`);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
    expect(JSON.stringify(readOnly) === JSON.stringify(READ_TOOLS), `marked as read-only: ${readOnly.join(', ')}`);
    return names.length === READ_TOOLS.length ? 'read-only' : `write tools: ${WRITE_TOOLS.join(', ')}`;
  });

  let location;
  await report.check('get_location: location_id', async () => {
    const { json } = await call('get_location', { location_id: locationId });
    expect(json.id === locationId, 'the answer is about another location');
    location = json;
    expect(typeof json.timezone_name === 'string' && json.timezone_name !== '', 'no timezone_name, which the tool promises');
    const confirmation = { true: 'is required', false: 'is not required' }[String(json.phone_confirmation)] ?? 'is not reported';
    return `fields: ${fieldsOf(json)}; phone confirmation ${confirmation}`;
  });
  // Without the location nothing below can pass: the token does not reach it, or the id is wrong.
  if (location === undefined) throw new Stop('the location did not answer');

  await report.check('get_location: another location is refused, the server is bound to one', async () => {
    const result = await call('get_location', { location_id: locationId + 1 });
    expect(result.isError && result.text.includes('is bound to location'), `expected a refusal, got: ${firstLine(result.text)}`);
    return 'refused';
  });

  if (formId === undefined) {
    report.skip('get_booking_form: form_id', 'no booking form id was given');
  } else {
    await report.check('get_booking_form: form_id', async () => {
      const { json } = await call('get_booking_form', { form_id: formId });
      expect(json.id === formId, 'the answer is about another form');
      expect(json.location_id === locationId, 'the form does not name this location');
      return `fields: ${fieldsOf(json)}`;
    });
  }

  let staff;
  await report.check('list_staff: without filters', async () => {
    const { json } = await call('list_staff', {});
    expect(json.returned === json.staff.length, 'returned does not match the list');
    expect(json.staff.every((item) => Number.isInteger(item.id) && typeof item.name === 'string'), 'a team member lacks id or name');
    staff = json.staff;
    return staff.length === 0 ? 'no team member is open for online booking' : `team members: ${json.returned}; fields: ${fieldsOf(staff[0])}`;
  });

  let member;
  await report.check('list_staff: only_bookable', async () => {
    need(staff, 'the team members');
    const { json } = await call('list_staff', { only_bookable: true });
    expect(json.staff.every((item) => item.bookable === true), 'a team member without free time came back');
    member = json.staff.find((item) => typeof item.seance_date === 'string') ?? json.staff[0];
    return `team members with free time: ${json.returned} of ${staff.length}`;
  });

  let service;
  await report.check('list_services: staff_id, only_catalog', async () => {
    need(member, 'a team member with free time');
    const { json } = await call('list_services', { staff_id: member.id, only_catalog: true });
    expect(json.returned === json.services.length && json.total >= json.returned, 'the counts do not match the list');
    expect(json.services.every((item) => Number.isInteger(item.id) && typeof item.title === 'string'), 'a service lacks id or title');
    [service] = json.services;
    return service === undefined
      ? 'the team member provides no service that can be booked online'
      : `services: ${json.total}; categories: ${json.categories.length}; fields: ${fieldsOf(service)}`;
  });

  await report.check('list_services: search, category_id, limit, offset', async () => {
    need(service, 'a service');
    const search = service.title.slice(0, 3);
    const filter = { only_catalog: true, search, ...(service.category_id === undefined ? {} : { category_id: service.category_id }) };
    const first = (await call('list_services', { ...filter, limit: 1, offset: 0 })).json;
    expect(first.returned === 1, `the service the text was taken from was not found (total ${first.total})`);
    expect(first.services[0].title.toLocaleLowerCase().includes(search.toLocaleLowerCase()), 'search was not applied');
    expect(service.category_id === undefined || first.services[0].category_id === service.category_id, 'category_id was not applied');
    expect(first.next_offset === (first.total > 1 ? 1 : null), `next_offset is ${first.next_offset} for a total of ${first.total}`);
    if (first.total === 1) return 'one service matches; there is no second one to try offset on';
    const second = (await call('list_services', { ...filter, limit: 1, offset: 1 })).json;
    expect(second.returned === 1 && second.services[0].id !== first.services[0].id, 'offset was not applied');
    return `services that match: ${first.total}; limit 1 with offset 0 and 1 gives two different ones`;
  });

  await report.check('list_staff: service_ids', async () => {
    need(service, 'a service');
    const { json } = await call('list_staff', { service_ids: [service.id] });
    expect(json.staff.some((item) => item.id === member.id), 'the team member whose service it is did not come back');
    return `team members with this service: ${json.returned}`;
  });

  let day;
  await report.check('list_available_dates: service_ids, staff_id', async () => {
    need(service, 'a service');
    const { json } = await call('list_available_dates', { service_ids: [service.id], staff_id: member.id });
    expect([...json.booking_dates, ...json.working_dates].every((item) => DATE.test(item)), 'a date is not written as YYYY-MM-DD');
    // The last day the API offers, and not today: a slot of today may be gone before it is checked.
    day = json.booking_dates.filter((item) => item > today()).at(-1);
    return `days with free time: ${json.booking_dates.length}; working days: ${json.working_dates.length}`;
  });

  await report.check('list_available_dates: month', async () => {
    need(day, 'a day with free time');
    const { json } = await call('list_available_dates', { service_ids: [service.id], staff_id: member.id, month: day });
    expect(json.booking_dates.includes(day), 'the day with free time is missing from its own month');
    const other = json.booking_dates.filter((item) => !item.startsWith(day.slice(0, 7)));
    expect(other.length === 0, `${other.length} of ${json.booking_dates.length} dates are outside the month that was asked for`);
    return `days with free time in the month: ${json.booking_dates.length}`;
  });

  await report.check('list_available_dates: date_from, date_to', async () => {
    need(day, 'a day with free time');
    // The week that ends on the chosen day, which is the last free one.
    const period = { date_from: addDays(day, -6), date_to: day };
    const { json } = await call('list_available_dates', { service_ids: [service.id], staff_id: member.id, ...period });
    expect(json.booking_dates.includes(day), 'the last day of the period, which has free time, is missing');
    const outside = [...json.booking_dates, ...json.working_dates].filter((item) => item < period.date_from || item > period.date_to);
    expect(outside.length === 0, `${outside.length} dates are outside the period that was asked for`);
    return `days with free time within the week: ${json.booking_dates.length}`;
  });

  let slot;
  await report.check('list_time_slots: staff_id, date, service_ids', async () => {
    need(day, 'a day with free time');
    const { json } = await call('list_time_slots', { staff_id: member.id, date: day, service_ids: [service.id] });
    expect(json.date === day && json.returned === json.slots.length, 'the counts do not match the list');
    expect(json.slots.length > 0, 'no slots on a day that list_available_dates gave as free');
    expect(json.slots.every((item) => typeof item.time === 'string' && SLOT_DATE_TIME.test(item.datetime)), 'a slot lacks its time, or its datetime has no UTC offset');
    expect(json.slots.every((item) => item.datetime.startsWith(day)), 'a slot of another day came back');
    slot = json.slots.at(-1);
    return `slots: ${json.returned}; fields: ${fieldsOf(slot)}`;
  });

  await report.check('list_time_slots: any team member (staff_id 0)', async () => {
    need(slot, 'a free slot');
    const { json } = await call('list_time_slots', { staff_id: 0, date: day, service_ids: [service.id] });
    expect(json.slots.length > 0, 'no slots for anyone on a day on which a team member has some');
    return `slots: ${json.returned}`;
  });

  await report.check('get_nearest_time_slots: staff_id, service_ids', async () => {
    need(service, 'a service');
    const result = await call('get_nearest_time_slots', { staff_id: member.id, service_ids: [service.id] });
    const { json } = result;
    expect(json !== undefined, `no data for a team member who has free time: ${firstLine(result.text)}`);
    expect(DATE.test(json.seance_date) && json.slots.length > 0 && json.returned === json.slots.length, 'no nearest day, or no slots on it');
    expect(json.slots.every((item) => SLOT_DATE_TIME.test(item.datetime)), 'the datetime of a slot has no UTC offset');
    return `slots on the nearest day: ${json.returned}`;
  });

  await report.check('get_nearest_time_slots: datetime', async () => {
    need(slot, 'a free slot');
    const result = await call('get_nearest_time_slots', { staff_id: member.id, service_ids: [service.id], datetime: `${day}T00:00:00` });
    const { json } = result;
    expect(json !== undefined, `no free time from a day that list_available_dates gave as free: ${firstLine(result.text)}`);
    expect(json.seance_date >= day, 'the nearest day is earlier than the moment the search was to start from');
    return 'the search starts from the given moment';
  });

  await report.check('list_staff: service_ids, datetime', async () => {
    need(slot, 'a free slot');
    const { json } = await call('list_staff', { service_ids: [service.id], datetime: slot.datetime });
    expect(json.staff.some((item) => item.id === member.id), 'the team member who is free at that moment did not come back');
    return `team members free at the slot: ${json.returned}`;
  });

  await report.check('list_services: staff_id, datetime, service_ids', async () => {
    need(slot, 'a free slot');
    const { json } = await call('list_services', { staff_id: member.id, datetime: slot.datetime, service_ids: [service.id] });
    expect(Array.isArray(json.services) && json.returned === json.services.length, 'the counts do not match the list');
    return `services that can go with the chosen one at the slot: ${json.total}`;
  });

  await report.check('check_booking: a slot that was just listed can be booked', async () => {
    need(slot, 'a free slot');
    const { json } = await call('check_booking', { staff_id: member.id, datetime: slot.datetime, service_ids: [service.id] });
    expect(json.can_be_booked === true, `Altegio refuses a slot it has just listed: ${codesOf(json.reasons)}`);
    return 'can be booked; nothing was created';
  });

  await report.check('check_booking: yesterday comes back as not bookable, with the reasons', async () => {
    need(slot, 'a free slot');
    // The same time of day and UTC offset as the slot, one day before today.
    const yesterday = `${addDays(today(), -1)}${slot.datetime.slice(10)}`;
    const { json } = await call('check_booking', { staff_id: member.id, datetime: yesterday, service_ids: [service.id] });
    expect(json.can_be_booked === false, 'Altegio accepts a booking for yesterday');
    expect(Array.isArray(json.reasons) && json.reasons.length > 0, 'no reasons came with the refusal');
    return `refused: ${codesOf(json.reasons)}`;
  });

  await report.check('get_booking: a booking nobody made is refused by the API', async () => {
    const result = await call('get_booking', { record_id: 1, record_hash: MADE_UP_HASH });
    expect(result.isError, 'a booking came back for a made-up id and hash');
    const status = /^Altegio API error \(HTTP (\d+)\)/.exec(result.text)?.[1];
    expect(status !== undefined, firstLine(result.text));
    return `refused with HTTP ${status}`;
  });

  if (write) {
    const WRITE_CHECKS = 'create_booking, get_booking, cancel_booking';
    if (slot === undefined) {
      report.skip(WRITE_CHECKS, 'no free slot was found to book');
    } else {
      report.say('');
      report.say(`Write check: one booking at location ${locationId}, cancelled at once.`);
      report.say(`  when: ${slot.datetime.slice(0, 10)} at ${slot.time}, local time of the location`);
      report.say(`  what: a service of a team member with free time, for the client "${CLIENT_NAME}" with the phone you gave`);
      const answer = await prompt.line('Type yes to create this booking and cancel it: ');
      if (answer.toLowerCase() !== 'yes') {
        report.skip(WRITE_CHECKS, 'not confirmed, nothing was created');
      } else {
        let code;
        if (location.phone_confirmation === true) {
          const sent = await report.check('send_phone_confirmation_code: client_phone', async () => {
            const result = await call('send_phone_confirmation_code', { client_phone: phone });
            expect(!result.isError, result.text);
            return 'Altegio accepted the request';
          });
          if (sent) {
            code = await prompt.secret('Code from the SMS (input is hidden): ');
            report.hide(code);
          }
        } else {
          report.skip('send_phone_confirmation_code: client_phone', 'the location does not confirm phones by SMS');
        }

        const externalId = `live-check-${Date.now()}`;
        let booking;
        await report.check('create_booking: every argument but the e-mail', async () => {
          const result = await call('create_booking', {
            client_name: CLIENT_NAME,
            client_phone: phone,
            staff_id: member.id,
            datetime: slot.datetime,
            service_ids: [service.id],
            comment: COMMENT,
            sms_reminder_hours: 0,
            email_reminder_hours: 0,
            external_id: externalId,
            ...(code === undefined || code === '' ? {} : { phone_confirmation_code: code }),
          });
          const when = `${slot.datetime.slice(0, 10)} at ${slot.time}`;
          if (result.isError && result.text.includes(UNKNOWN_OUTCOME)) leftover = { id: 'with an unknown id', when, doubt: true };
          // A refusal ends the check here. Past this line Altegio said yes: a booking exists, whether or not
          // the answer holds what is needed to cancel it.
          const { json } = result;
          leftover = { id: Number.isInteger(json?.record_id) ? String(json.record_id) : 'with an unknown id', when };
          expect(Number.isInteger(json?.record_id) && typeof json.record_hash === 'string', `no record_id or record_hash came back: ${firstLine(result.text)}`);
          report.hide(json.record_hash);
          booking = json;
          return `booking ${json.record_id} created`;
        });

        if (booking !== undefined) {
          const reference = { record_id: booking.record_id, record_hash: booking.record_hash };
          try {
            await report.check('get_booking: the booking that was just made', async () => {
              const { json } = await call('get_booking', reference);
              expect(json.id === booking.record_id, 'another booking came back');
              expect(json.deleted !== true, 'the new booking is already marked as deleted');
              expect(Date.parse(json.datetime) === Date.parse(slot.datetime), 'the booking is at another time than the slot');
              expect(json.services.some((item) => item.id === service.id), 'the service is missing from the booking');
              expect(json.staff?.id === member.id, 'the booking is with another team member');
              expect(String(json.api_id) === externalId, 'external_id did not come back as api_id');
              const cancelling = { true: 'lets clients cancel', false: 'forbids clients to cancel' }[String(json.company?.allow_delete_record)];
              return `fields: ${fieldsOf(json)}; the location ${cancelling ?? 'does not say whether clients may cancel'}`;
            });
          } finally {
            // Whatever the check above found, the booking must not stay.
            await report.check('cancel_booking: record_id, record_hash', async () => {
              const result = await call('cancel_booking', reference);
              expect(!result.isError, result.text);
              return 'Altegio accepted the cancellation';
            });
          }

          await report.check('get_booking: after the cancellation the booking is gone', async () => {
            const result = await call('get_booking', reference);
            if (result.isError) {
              expect(/^Altegio API error \(HTTP 404\)/.test(result.text), `the cancellation could not be confirmed: ${firstLine(result.text)}`);
              leftover = undefined;
              return 'Altegio no longer finds it';
            }
            expect(result.json.deleted === true, 'the booking is still there and is not marked as deleted');
            leftover = undefined;
            return 'marked as deleted';
          });
        }
      }
    }
  }
} catch (error) {
  if (error instanceof Interrupted) {
    report.say('Interrupted.');
    report.counts.failed += 1;
  } else if (error instanceof Stop) {
    report.say('Stopped: the remaining checks were not run.');
    report.counts.failed += report.counts.failed === 0 ? 1 : 0;
  } else {
    throw error;
  }
} finally {
  if (leftover !== undefined) {
    report.say('');
    report.say(
      leftover.doubt === true
        ? `!!! The test booking MAY EXIST: Altegio gave no definite answer when it was created.`
        : `!!! The test booking was NOT cancelled, or its cancellation could not be confirmed.`,
    );
    report.say(`!!! Location ${locationId}, ${leftover.when}, client "${CLIENT_NAME}", booking ${leftover.id}: look it up in Altegio and delete it by hand.`);
  }
}

await client.close();
await exitAfterOutput(report.finish());
