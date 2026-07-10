'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessBoundaryError, HttpStatusError, SecurityChallengeError } = require('../../src/aggregator/errors');
const { HttpTransport, looksLikeSecurityChallenge, parseRetryAfter } = require('../../src/aggregator/transport');

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function transport(options = {}) {
  return new HttpTransport({
    allowedDomains: ['127.0.0.1'],
    retries: 1,
    delayMs: 0,
    sleep: async () => {},
    random: () => 0,
    ...options,
  });
}

test('retries 429 and 5xx responses, then succeeds', async () => {
  for (const temporaryStatus of [429, 503]) {
    let calls = 0;
    await withServer((request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(temporaryStatus, { 'Retry-After': '0' });
        response.end('wait');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('ok');
      }
    }, async (baseUrl) => {
      const result = await transport().getText(`${baseUrl}/retry`, { cache: false });
      assert.equal(result.body, 'ok');
      assert.equal(calls, 2);
    });
  }
});

test('does not retry a permanent 404', async () => {
  let calls = 0;
  await withServer((request, response) => {
    calls += 1;
    response.writeHead(404);
    response.end('missing');
  }, async (baseUrl) => {
    await assert.rejects(() => transport({ retries: 3 }).getText(`${baseUrl}/missing`, { cache: false }), HttpStatusError);
    assert.equal(calls, 1);
  });
});

test('retries a timeout and completes the next request', async () => {
  let calls = 0;
  await withServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      setTimeout(() => {
        if (!response.destroyed) response.end('late');
      }, 80);
    } else response.end('ok');
  }, async (baseUrl) => {
    const result = await transport({ timeoutMs: 15 }).getText(`${baseUrl}/timeout`, { cache: false });
    assert.equal(result.body, 'ok');
    assert.equal(calls, 2);
  });
});

test('blocks a redirect outside the allowlist before following it', async () => {
  await withServer((request, response) => {
    response.writeHead(302, { Location: 'https://example.com/outside' });
    response.end();
  }, async (baseUrl) => {
    await assert.rejects(() => transport().getText(`${baseUrl}/redirect`, { cache: false }), AccessBoundaryError);
  });
});

test('stops on CAPTCHA or security challenge HTML', async () => {
  const challenge = fs.readFileSync(path.join(__dirname, 'fixtures', 'security-challenge.html'), 'utf8');
  assert.equal(looksLikeSecurityChallenge(challenge, 'text/html'), true);
  await withServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(challenge);
  }, async (baseUrl) => {
    await assert.rejects(() => transport().getText(`${baseUrl}/challenge`, { cache: false }), SecurityChallengeError);
  });
});

test('uses a local response cache without a second request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aggregator-cache-'));
  let calls = 0;
  try {
    await withServer((request, response) => {
      calls += 1;
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end('<feed/>');
    }, async (baseUrl) => {
      const client = transport({ cacheDirectory: directory, cacheTtlMs: 60000 });
      await client.getText(`${baseUrl}/feed`);
      const cached = await client.getText(`${baseUrl}/feed`);
      assert.equal(cached.fromCache, true);
      assert.equal(calls, 1);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parses Retry-After seconds and dates', () => {
  assert.equal(parseRetryAfter('3', 0), 3000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
  assert.equal(parseRetryAfter('invalid', 0), null);
});
