# altegio-mcp

An [MCP](https://modelcontextprotocol.io) server for the online booking API of [Altegio](https://alteg.io), a booking and business management system for salons, clinics, studios and other service businesses. It lets an AI assistant such as Claude answer "what can I book, with whom and when" for a location, and, only if you explicitly allow it, create and cancel bookings.

Українською: [README.uk.md](README.uk.md)

> **Unofficial.** This project is not affiliated with or endorsed by Altegio. "Altegio" is a trademark of its owner. Use it at your own risk: a booking created through the write tools takes real time in a real schedule.

> **Status: 0.1.0, not yet verified on a live Altegio account.** The server is built from the two OpenAPI documents Altegio publishes on [developer.alteg.io](https://developer.alteg.io): "Online Booking" and "Business Management v1" (both version 1.0.0 on 2026-10-08). All tests run against a mocked HTTP layer and check every request against a snapshot of those documents. Nobody has run it with a real partner token yet. See [Limitations](#limitations).

## What it is for

Altegio businesses publish a booking widget where a client picks a service, a team member and a time. The same steps are available to partners as an API. This server exposes those steps as MCP tools, so an assistant, a chat bot or a voice agent can lead a client through a booking in conversation.

It sees what the widget sees: services, team members, free time and the bookings it made itself. It does not see the schedule, the client base or the finances of a business; that part of the Altegio API needs a user token and is out of scope.

Altegio also runs its own hosted [Integrations Hub MCP](https://developer.alteg.io/en/developers/integrations-hub-mcp). That one manages marketplace applications in a developer account. It does a different job and does not replace this server, nor the other way round.

## Quick start

You need Node.js 20 or newer, a **partner token** and the **id of a location**.

- The partner token appears in the Altegio developer account under Account settings → Account details after you register as a developer in the [Altegio Marketplace](https://app.alteg.io/appstore/developers/1). See Altegio's [How to Get API Keys](https://developer.alteg.io/en/get-api-key).
- The location id is the number of the branch in Altegio. If you only have a widget link such as `https://b123.alteg.io`, the tool `get_booking_form` turns the form id `123` into a location id.

> **Not on npm yet.** Until the first release is published, the `npx -y @myradostudio/altegio-mcp` commands below will not work. Run the server from source instead: `git clone https://github.com/myradostudio/altegio-mcp`, then `npm install` and `npm run build` in that folder, and use `"command": "node"` with `"args": ["/absolute/path/to/altegio-mcp/dist/index.js"]` in the configurations below.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "altegio": {
      "command": "npx",
      "args": ["-y", "@myradostudio/altegio-mcp"],
      "env": {
        "ALTEGIO_PARTNER_TOKEN": "your partner token",
        "ALTEGIO_LOCATION_ID": "your location id"
      }
    }
  }
}
```

If the server does not start on Windows, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@myradostudio/altegio-mcp"]`.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env ALTEGIO_PARTNER_TOKEN=your-partner-token \
  --env ALTEGIO_LOCATION_ID=your-location-id \
  altegio -- npx -y @myradostudio/altegio-mcp
```

### Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "altegio": {
      "command": "npx",
      "args": ["-y", "@myradostudio/altegio-mcp"],
      "env": {
        "ALTEGIO_PARTNER_TOKEN": "your partner token",
        "ALTEGIO_LOCATION_ID": "your location id"
      }
    }
  }
}
```

Any other MCP client that can start a local stdio server works the same way: run `npx -y @myradostudio/altegio-mcp` with the environment variables below.

Then ask, for example:

- "What services does the salon offer, and how much is a haircut?"
- "Who does manicure, and when is the earliest free time this week?"
- "Is Olena free on Saturday at 15:30 for a haircut and colouring?"
- With write tools enabled: "Book Iryna, +380501234567, for a haircut with Olena on Saturday at 15:30."

## Configuration

The server is configured with environment variables only. It validates them at startup and exits with an explanation on stderr if something is wrong.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ALTEGIO_PARTNER_TOKEN` | yes | | Partner token of your Altegio developer account. The token alone, without `Bearer` and without a user token. |
| `ALTEGIO_LOCATION_ID` | no | | Numeric id of a location. When set, the server is bound to it: `location_id` can be left out of every call, and a call that names another location is refused. When not set, every tool that works with a location needs `location_id`. |
| `ALTEGIO_API_URL` | no | `https://api.alteg.io` | API origin. Must be `https://` (plain `http://` is accepted for localhost only). |
| `ALTEGIO_ALLOW_WRITE` | no | off | Set to `1` to register the write tools. Any other value than `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` stops the server. |

## Tools

Ids are numbers. Durations (`seance_length`, `sum_length`) are in seconds. Prices are in the currency of the location. Slot times are local to the location; `get_location` returns its time zone. The server tells the model so.

### Read tools (always available)

| Tool | What it returns | API call |
| --- | --- | --- |
| `get_location` | Name, city, address, time zone of a location and whether bookings need SMS confirmation of the phone | `GET /locations/{location_id}` |
| `get_booking_form` | Settings of a booking widget by its id, including the location it belongs to | `GET /bookform/{id}` |
| `list_services` | Services open for online booking with categories, price range and duration | `GET /book_services/{location_id}` |
| `list_staff` | Team members open for online booking, optionally only those who provide given services | `GET /book_staff/{location_id}` |
| `list_available_dates` | Dates that still have free time, and working dates | `GET /book_dates/{location_id}` |
| `list_time_slots` | Free time slots of a team member (or of anyone) on a date | `GET /book_times/{location_id}/{team_member_id}/{date}` |
| `get_nearest_time_slots` | The nearest day with free time for a team member, with its slots | `GET /book_staff_seances/{location_id}/{team_member_id}` |
| `check_booking` | Whether a visit can be booked right now, with Altegio's reasons if not | `POST /book_check/{location_id}` |
| `get_booking` | A booking by its id and hash: time, services, team member, location | `GET /book_record/{location_id}/{record_id}/{record_hash}` |

All paths are relative to `https://api.alteg.io/api/v1`.

`check_booking` is the one read tool that sends a `POST`. That is how Altegio documents the validation of booking parameters; according to the documentation it creates nothing, and it does not reserve the slot either.

`list_services` returns up to 100 services per call (500 at most) and supports `search`, `category_id`, `limit` and `offset`. Those four are applied by the server to the list Altegio returned: the API itself has no paging or text search for services.

### Write tools (only with `ALTEGIO_ALLOW_WRITE=1`)

| Tool | What it does | API call |
| --- | --- | --- |
| `create_booking` | Books one visit: one or several services with one team member at one start time | `POST /book_record/{location_id}` |
| `send_phone_confirmation_code` | Makes Altegio send an SMS code to the client phone, for locations that require confirmation | `POST /book_code/{location_id}` |
| `cancel_booking` | Deletes a booking by its id and hash | `DELETE /user/records/{record_id}/{record_hash}` |

`create_booking` returns `record_id` and `record_hash`. Keep both: with the partner token alone they are the only way to view or cancel that booking.

## Safety model

A booking occupies a real person's time and can trigger messages to a client, so the server is conservative by design.

- **Read-only unless you opt in.** Without `ALTEGIO_ALLOW_WRITE=1` the write tools are not registered at all: the model cannot see or call them. A test enforces that the read tools send nothing but `GET`, with the single documented exception of `check_booking`.
- **One location, if you say so.** With `ALTEGIO_LOCATION_ID` set, no tool that takes a location accepts another one. `cancel_booking` has no location in its address, so the binding cannot apply to it; it needs the hash of the booking, which is known only for bookings made through the same integration.
- **Honest annotations.** Read tools carry `readOnlyHint: true`. `create_booking` and `send_phone_confirmation_code` add something and are marked as non-destructive writes; `cancel_booking` removes a booking and carries `destructiveHint: true`. No write tool claims to be idempotent. Whether and how confirmation is shown is up to your MCP client; keep per-call approval switched on for the write tools.
- **Strict input.** Every tool rejects arguments it does not know, so a filter the API does not have is never silently ignored. `create_booking` wants the start time with a UTC offset, exactly as a slot returns it, so that "15:30" cannot be read in the wrong time zone.
- **No blind retries.** The server never repeats a request on its own. If a write ends without a definite answer (a timeout, a broken connection, a gateway error, HTTP 429, an unreadable response), the tool says that the outcome is unknown and how to check it. Altegio documents no way to make a booking request safe to repeat, so a blind retry could book the same visit twice.
- **Stays within the documented rate.** Altegio allows 200 requests per minute and 5 per second from one IP address. The server paces its own requests accordingly: a short burst waits up to two seconds, and beyond that the tool reports when to try again instead of sending.
- **The token stays local.** It is read from an environment variable, used only for requests to `ALTEGIO_API_URL`, and never written to stdout, stderr or tool results. Redirects are not followed, so neither the token nor a client's phone number can end up on another host.
- **Less data to the model.** Tools return compact objects without avatars, widget styling, analytics ids and HTML biographies.
- **No telemetry, no logging of business data.** stderr gets only startup messages (configuration problems and a one-line banner with the mode) and the type of a transport error. Requests and responses are never logged.

Two things the server cannot do for you. First, whatever a tool returns is sent to the AI model you use and to its provider, and `create_booking` passes a client's name and phone through that model; decide whether that is acceptable and lawful for your clients' data. Second, names of services and comments stored in Altegio reach the model as-is and could contain instructions written by someone else (prompt injection). That is one more reason to approve every write call yourself.

## Limitations

- **Not verified on a live account.** Requests are checked against the OpenAPI documents, which describe shapes, not behaviour. Response handling and error texts are implemented from the documentation and its examples. In particular, nobody has confirmed yet which locations answer to a given partner token, or how a location that disabled online booking responds.
- **Partner token only.** Everything that needs a user token is out of scope: listing or searching the bookings of a location, the client base, moving a booking to another time (`PUT /book_record`), the schedule, sales and finances.
- **`cancel_booking` depends on the location.** Altegio documents the hash as meant for deleting a booking right after it was made, and a location can forbid clients to cancel (`allow_delete_record`). Expect a refusal in both cases.
- **One visit per call.** The API accepts several visits in one request; `create_booking` sends one, with one or several services.
- **Not covered:** group events, online payment and deposits, custom booking fields, loyalty cards and memberships, reviews, the client's personal cabinet.
- **Four places where the documents contradict themselves.** The server follows the reading that looks right and the tests list each case, so a correction on Altegio's side will be noticed:
  - the `datetime` filter of `list_staff` and `get_nearest_time_slots` is declared as a number but described as an ISO 8601 date; the server sends the ISO 8601 text;
  - in `create_booking`, the SMS code (`code`) and the external id (`api_id`) are declared as numbers in the schema and as strings in the field table; the server sends strings, so a code that starts with 0 survives.
- **Lists of ids.** `service_ids[]` is declared as an array in three operations and as a string in two. The server always sends repeated keys (`service_ids[]=1&service_ids[]=2`). With a single service the two readings give the same request; with several, this has to be confirmed on a live account.
- **`send_phone_confirmation_code` sends the phone only.** The optional client name is left out, because the schema and the description of the documentation spell that field differently.
- **Pacing is per server process.** Altegio counts requests per IP address. Other programs behind the same address spend the same allowance, so the API can still answer HTTP 429.
- **Fixed 30-second timeout** per request.

## Development

```bash
npm install
npm run lint          # tsc --noEmit over src/ and tests/
npm test              # builds dist/ and the tests, then runs them with node:test
npm run spec:update   # refreshes the OpenAPI snapshot from developer.alteg.io
```

- `src/endpoints.ts` is the catalogue of API operations the server calls. `tests/spec.test.ts` compares it with `spec/altegio-api.snapshot.json`, a reduced copy of the official OpenAPI documents (parameters, request schemas and security of those operations only), and checks that every operation is documented with the partner token alone.
- Every tool test calls the tool through a real MCP client and passes each recorded request through `assertMatchesSpec`, which checks the path, query parameters, headers and body against that snapshot.
- `tests/e2e.test.ts` starts the built server as a child process over stdio against a local HTTP mock.
- To poke at the server by hand: `npx @modelcontextprotocol/inspector node dist/index.js`.

The server uses the official TypeScript SDK ([`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server)) and `zod`; there are no other runtime dependencies.

Issues and pull requests are welcome. For security reports see [SECURITY.md](SECURITY.md).

## Built by

Built and maintained by [Myrado Studio](https://myradostudio.com) — custom MCP servers, AI agents and automation. Need an MCP server for your own system? https://myradostudio.com/en/mcp-server-development/

## License

[MIT](LICENSE) © 2026 Myrado Studio
