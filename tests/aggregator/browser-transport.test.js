'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserTransport } = require('../../src/aggregator/browser_transport');
const { AccessBoundaryError } = require('../../src/aggregator/errors');

test('browser transport enforces allowlist before launching Chromium', async () => {
  let launched = false;
  const browser = new BrowserTransport({
    allowedDomains: ['www.estate.am'],
    chromium: {
      launch: async () => {
        launched = true;
        throw new Error('must not launch');
      },
    },
  });
  await assert.rejects(() => browser.open('https://example.com/listings'), AccessBoundaryError);
  assert.equal(launched, false);
});
