# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **hello@myradostudio.com** with a description, the affected version and, if you can, steps to reproduce.

Never include a real partner token, booking hashes or client data in a report. If a partner token has been exposed, ask Altegio (api@alteg.io) how to replace it; this project does not know of a self-service way to do so.

## Supported versions

Only the latest published version receives fixes.

## What the server does with your data

- The partner token (`ALTEGIO_PARTNER_TOKEN`) is read from an environment variable and sent only to the API origin in `ALTEGIO_API_URL` (by default `https://api.alteg.io`). Plain `http://` is refused for anything but localhost.
- Nothing is written to disk. stderr receives startup messages and the type of a transport error; requests, responses, the token, client names and phone numbers are never logged. There is no telemetry.
- Tool results go to the MCP client and from there to the AI model you use. `get_booking` returns the details of a booking; `create_booking` receives the client name, phone and e-mail from the model and sends them to Altegio.

## Things to keep in mind

- `ALTEGIO_ALLOW_WRITE=1` lets the connected AI model create and cancel bookings and make Altegio send SMS codes. Keep per-call confirmation enabled in your MCP client.
- Set `ALTEGIO_LOCATION_ID` whenever the server serves one business: the tools then refuse any other location. `cancel_booking` is addressed by booking id and hash alone and is not covered by that binding; the hash is known only for bookings made through the same integration.
- A booking hash (`record_hash`) lets its holder view and cancel that booking. Treat it like a password for the booking.
- Your MCP client stores the environment variables you give it, usually in a plain-text configuration file. Protect that file like any other credential store.
- Text stored in Altegio (names of services, comments) is passed to the model unchanged and can carry prompt-injection attempts.
- This is an unofficial project. It is not affiliated with or endorsed by Altegio.
