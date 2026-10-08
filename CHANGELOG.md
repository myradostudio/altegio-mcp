# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

First release. Built from the "Online Booking" and "Business Management v1" OpenAPI documents published on developer.alteg.io (both version 1.0.0 on 2026-10-08); not yet verified on a live Altegio account.

### Added

- stdio MCP server, started with `npx -y @myradostudio/altegio-mcp`, configured with environment variables.
- Authorization with the partner token only. `ALTEGIO_LOCATION_ID` binds the server to one location.
- 9 read-only tools: `get_location`, `get_booking_form`, `list_services`, `list_staff`, `list_available_dates`, `list_time_slots`, `get_nearest_time_slots`, `check_booking`, `get_booking`.
- 3 write tools, registered only with `ALTEGIO_ALLOW_WRITE=1`: `create_booking`, `send_phone_confirmation_code`, `cancel_booking`.
- Request pacing within the documented limits (5 requests per second, 200 per minute), a request timeout, no following of redirects, API errors returned as tool errors with the message and the error codes of the API.
- Write tools report an unknown outcome (timeout, gateway error, unreadable response) together with the way to check it, instead of inviting a blind retry.
- `server.json` for the MCP registry.
- Tests with a mocked HTTP layer that check every request against a snapshot of the official OpenAPI documents, and an end-to-end test over stdio.

[0.1.0]: https://github.com/myradostudio/altegio-mcp/releases/tag/v0.1.0
