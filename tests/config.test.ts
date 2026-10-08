import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_API_URL, loadConfig } from '../src/config.js';

const TOKEN = 'gtcwf654agufy25gsadh';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

describe('loadConfig', () => {
  it('needs only the partner token, defaulting to production, read-only and no preset location', () => {
    const config = loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN });
    assert.equal(config.partnerToken, TOKEN);
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.apiUrl, 'https://api.alteg.io');
    assert.equal(config.allowWrite, false);
    assert.equal(config.locationId, undefined);
    assert.deepEqual(config.notices, []);
  });

  it('reads the preset location as a number', () => {
    const config = loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_LOCATION_ID: '4564' });
    assert.equal(config.locationId, 4564);
  });

  it('treats blank values as unset and trims whitespace', () => {
    const config = loadConfig({
      ALTEGIO_PARTNER_TOKEN: `  ${TOKEN} `,
      ALTEGIO_LOCATION_ID: '   ',
      ALTEGIO_API_URL: '',
      ALTEGIO_ALLOW_WRITE: '',
    });
    assert.equal(config.partnerToken, TOKEN);
    assert.equal(config.locationId, undefined);
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.allowWrite, false);
  });

  it('drops a pasted "Bearer " prefix and says so', () => {
    const config = loadConfig({ ALTEGIO_PARTNER_TOKEN: `Bearer ${TOKEN}` });
    assert.equal(config.partnerToken, TOKEN);
    assert.equal(config.notices.length, 1);
    assert.match(config.notices[0] ?? '', /prefix was dropped/);
    assert.ok(!config.notices.join(' ').includes(TOKEN), 'a notice never repeats the token');
  });

  it('rejects a missing partner token and tells where to find it', () => {
    const problems = problemsOf({});
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /ALTEGIO_PARTNER_TOKEN is not set/);
    assert.match(problems[0] ?? '', /Account settings/);
  });

  it('rejects a token with a user token appended, which would change who the request acts as', () => {
    for (const value of [`${TOKEN}, User abcdef`, `${TOKEN} extra`, `${TOKEN},abc`]) {
      const problems = problemsOf({ ALTEGIO_PARTNER_TOKEN: value });
      assert.match(problems.join('\n'), /without spaces or commas/, value);
      assert.ok(!problems.join('\n').includes(TOKEN), 'a problem never repeats the token');
    }
  });

  it('rejects a location id that is not a positive integer', () => {
    for (const value of ['0', '-5', '12.5', 'abc', '4564x', '0123']) {
      assert.match(
        problemsOf({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_LOCATION_ID: value }).join('\n'),
        /ALTEGIO_LOCATION_ID must be the numeric id/,
        value,
      );
    }
  });

  it('enables write tools only for explicit true values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_ALLOW_WRITE: value }).allowWrite, true, value);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      assert.equal(loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_ALLOW_WRITE: value }).allowWrite, false, value);
    }
  });

  it('stops on an unrecognised ALTEGIO_ALLOW_WRITE instead of guessing', () => {
    const problems = problemsOf({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_ALLOW_WRITE: 'enabled' });
    assert.match(problems.join('\n'), /ALTEGIO_ALLOW_WRITE must be 1/);
  });

  it('warns when write tools are enabled without a preset location', () => {
    const open = loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_ALLOW_WRITE: '1' });
    assert.match(open.notices.join('\n'), /bookings can be created at any location/);

    const bound = loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_ALLOW_WRITE: '1', ALTEGIO_LOCATION_ID: '4564' });
    assert.deepEqual(bound.notices, []);
  });

  it('accepts another https origin and plain http for localhost only', () => {
    assert.equal(
      loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_API_URL: 'https://api.example.com/' }).apiUrl,
      'https://api.example.com',
    );
    assert.equal(
      loadConfig({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_API_URL: 'http://127.0.0.1:8080' }).apiUrl,
      'http://127.0.0.1:8080',
    );
    assert.match(
      problemsOf({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_API_URL: 'http://api.example.com' }).join('\n'),
      /must use https/,
    );
  });

  it('rejects an API URL with a path, a query, credentials or no scheme', () => {
    const cases: Record<string, RegExp> = {
      'https://api.alteg.io/api/v1': /origin only/,
      'https://api.alteg.io/?x=1': /origin only/,
      'https://user:pass@api.alteg.io': /must not contain credentials/,
      'api.alteg.io': /not a valid URL/,
    };
    for (const [value, expected] of Object.entries(cases)) {
      assert.match(problemsOf({ ALTEGIO_PARTNER_TOKEN: TOKEN, ALTEGIO_API_URL: value }).join('\n'), expected, value);
    }
  });

  it('reports every problem at once', () => {
    const problems = problemsOf({ ALTEGIO_LOCATION_ID: 'x', ALTEGIO_API_URL: 'ftp://x', ALTEGIO_ALLOW_WRITE: 'maybe' });
    assert.equal(problems.length, 4);
  });

  it('formats the problems as a list in the error message', () => {
    assert.throws(
      () => loadConfig({}),
      (error: unknown) => error instanceof ConfigError && /^Invalid configuration:\n  - ALTEGIO_PARTNER_TOKEN/.test(error.message),
    );
  });
});
