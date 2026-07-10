'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SourceAdapter } = require('../../src/aggregator/adapters/base');
const { loadAggregatorConfig, loadFacebookGroups } = require('../../src/aggregator/config');
const { AggregatorRunner } = require('../../src/aggregator/runner');
const { AggregatorStorage } = require('../../src/aggregator/storage');
const { makeListing } = require('./helpers');

function runnerWith(adapter) {
  const config = loadAggregatorConfig();
  config.sources.test_source = {
    source_type: 'website',
    base_url: 'https://example.test/',
    allowed_domains: ['example.test'],
    status: 'supported',
    access_method: 'fixture',
    supports_complete_snapshot: false,
    reason: 'Test adapter',
  };
  config.defaults.max_pages = 10;
  config.defaults.max_records = 100;
  const storage = new AggregatorStorage(':memory:');
  storage.syncConfiguration(config, loadFacebookGroups(config));
  const adapters = new Map([['test_source', adapter]]);
  return { runner: new AggregatorRunner(config, storage, adapters), storage };
}

class InterruptedAdapter extends SourceAdapter {
  async *pages() {
    yield {
      items: [makeListing({ source: 'test_source', source_listing_id: '1', canonical_url: 'https://example.test/1', source_url: 'https://example.test/1', contact_url: 'https://example.test/1' })],
      pageNumber: 1, cursor: '1', complete: false, sourceUrl: 'fixture://one',
    };
    throw new Error('simulated interruption');
  }
}

class ResumedAdapter extends SourceAdapter {
  async *pages(context) {
    assert.equal(context.resumeCursor, '1');
    yield {
      items: [makeListing({ source: 'test_source', source_listing_id: '2', canonical_url: 'https://example.test/2', source_url: 'https://example.test/2', contact_url: 'https://example.test/2' })],
      pageNumber: 2, cursor: null, complete: true, sourceUrl: 'fixture://two',
    };
  }
}

test('runner resumes after an interruption without duplicating the first page', async () => {
  const interrupted = new InterruptedAdapter('test_source', { supports_complete_snapshot: false });
  const { runner, storage } = runnerWith(interrupted);
  try {
    const failed = await runner.crawlSource('test_source');
    assert.equal(failed.stopReason, 'failed');
    assert.equal(storage.getListings().length, 1);
    assert.equal(storage.getCheckpoint('test_source').cursor, '1');
    runner.adapters.set('test_source', new ResumedAdapter('test_source', { supports_complete_snapshot: false }));
    const resumed = await runner.crawlSource('test_source', { resume: true });
    assert.equal(resumed.inserted, 1);
    assert.equal(storage.getListings().length, 2);
    assert.equal(storage.getCheckpoint('test_source'), null);
  } finally {
    storage.close();
  }
});

class SinglePageAdapter extends SourceAdapter {
  async *pages() {
    yield {
      items: ['1', '2', '3'].map((id) => makeListing({
        source: 'test_source', source_listing_id: id,
        canonical_url: `https://example.test/${id}`,
        source_url: `https://example.test/${id}`,
        contact_url: `https://example.test/${id}`,
      })),
      pageNumber: 1, cursor: null, complete: true, sourceUrl: 'fixture://page',
    };
  }
}

test('runner resumes inside a page after the record limit', async () => {
  const adapter = new SinglePageAdapter('test_source', { supports_complete_snapshot: false });
  const { runner, storage } = runnerWith(adapter);
  try {
    const limited = await runner.crawlSource('test_source', { maxRecords: 1 });
    assert.equal(limited.stopReason, 'record_limit');
    assert.equal(storage.getCheckpoint('test_source').payload.itemOffset, 1);
    const resumed = await runner.crawlSource('test_source', { resume: true, maxRecords: 10 });
    assert.equal(resumed.inserted, 2);
    assert.equal(storage.getListings().length, 3);
    assert.equal(storage.getCheckpoint('test_source'), null);
  } finally {
    storage.close();
  }
});

class CyclicAdapter extends SourceAdapter {
  async *pages() {
    yield { items: [], pageNumber: 1, cursor: 'same', complete: false, sourceUrl: 'fixture://one' };
    yield { items: [], pageNumber: 2, cursor: 'same', complete: false, sourceUrl: 'fixture://two' };
    yield { items: [], pageNumber: 3, cursor: 'never', complete: false, sourceUrl: 'fixture://three' };
  }
}

test('runner stops a source that repeats its pagination cursor', async () => {
  const adapter = new CyclicAdapter('test_source', { supports_complete_snapshot: false });
  const { runner, storage } = runnerWith(adapter);
  try {
    const result = await runner.crawlSource('test_source');
    assert.equal(result.stopReason, 'pagination_cycle');
    assert.equal(result.pages, 2);
  } finally {
    storage.close();
  }
});
