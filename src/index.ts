#!/usr/bin/env node
/**
 * Entry point: `npx -y @myradostudio/altegio-mcp`.
 *
 * stdout carries the MCP protocol, so every diagnostic goes to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { AltegioClient } from './client.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(error.message);
    log('See the README for the list of environment variables.');
    process.exitCode = 1;
    return;
  }
  for (const notice of config.notices) log(notice);

  const client = new AltegioClient({ config });

  const handle = serveStdio(() => createServer({ config, client }), {
    // Only the error type is logged: the message of a parse error can quote the
    // offending input, and tool arguments contain client names and phone numbers.
    onerror: (error) => log(`Transport error (${error.name}).`),
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const mode = config.allowWrite ? 'WRITE TOOLS ENABLED (bookings can be created and cancelled)' : 'read-only';
  const location = config.locationId === undefined ? 'no preset location' : `location ${config.locationId}`;
  log(`v${SERVER_VERSION} listening on stdio; ${mode}; API ${config.apiUrl}; ${location}.`);
}

try {
  main();
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : 'unexpected error'}`);
  process.exitCode = 1;
}
