'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertAllowedUrl, canonicalizeUrl } = require('../../src/aggregator/canonical');
const { AccessBoundaryError } = require('../../src/aggregator/errors');
const { collectPaginated } = require('../../src/aggregator/pagination');
const { parseRobotsTxt, robotsAllowsPath } = require('../../src/aggregator/robots');

test('canonical URL removes tracking, fragment, trailing slash, and normalizes HTTPS', () => {
  const actual = canonicalizeUrl(
    'http://www.estate.am/en/item/?utm_source=test&b=2&fbclid=x#photos',
    ['www.estate.am'],
  );
  assert.equal(actual, 'https://www.estate.am/en/item?b=2');
});

test('allowlist rejects redirects and URLs outside configured domains', () => {
  assert.throws(() => assertAllowedUrl('https://example.com/item', ['www.estate.am']), AccessBoundaryError);
  assert.throws(() => assertAllowedUrl('file:///etc/passwd', ['www.estate.am']), AccessBoundaryError);
  assert.doesNotThrow(() => assertAllowedUrl('https://www.estate.am/item', ['www.estate.am']));
});

test('pagination deduplicates records and saves checkpoints', async () => {
  const checkpoints = [];
  const result = await collectPaginated({
    fetchPage: async ({ pageNumber }) => ({
      items: pageNumber === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }],
      nextCursor: pageNumber === 0 ? 'next' : null,
    }),
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.deepEqual(result.records.map((item) => item.id), [1, 2, 3]);
  assert.equal(checkpoints.length, 2);
  assert.equal(result.stopReason, 'source_exhausted');
});

test('pagination stops after three pages without new unique records', async () => {
  let calls = 0;
  const result = await collectPaginated({
    fetchPage: async () => {
      calls += 1;
      return { items: [], nextCursor: String(calls) };
    },
    maxPages: 10,
  });
  assert.equal(calls, 3);
  assert.equal(result.stopReason, 'three_empty_pages');
});

test('pagination detects cursor cycles', async () => {
  const result = await collectPaginated({
    fetchPage: async () => ({ items: [], nextCursor: 'same' }),
    resumeCursor: 'same',
    maxPages: 5,
  });
  assert.equal(result.stopReason, 'pagination_cycle');
});

test('robots parser keeps the most specific path rule and crawl delay', () => {
  const policy = parseRobotsTxt('User-agent: *\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 10\nSitemap: https://example.test/sitemap.xml');
  assert.equal(policy.crawlDelay, 10);
  assert.equal(robotsAllowsPath(policy, '/private/file'), false);
  assert.equal(robotsAllowsPath(policy, '/private/public/item'), true);
  assert.deepEqual(policy.sitemaps, ['https://example.test/sitemap.xml']);
});
