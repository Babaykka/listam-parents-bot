'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadAggregatorConfig, loadFacebookGroups } = require('../../src/aggregator/config');
const { exportListings } = require('../../src/aggregator/exporter');
const { AggregatorStorage } = require('../../src/aggregator/storage');
const { makeListing } = require('./helpers');

function createStorage() {
  const storage = new AggregatorStorage(':memory:');
  const config = loadAggregatorConfig();
  storage.syncConfiguration(config, loadFacebookGroups(config));
  return storage;
}

test('repeated upsert is idempotent and a material change creates a version', () => {
  const storage = createStorage();
  try {
    const first = makeListing();
    const run = storage.startRun('estate_am');
    assert.equal(storage.upsertListing(first, run).action, 'inserted');
    assert.equal(storage.upsertListing({ ...first, scraped_at: '2026-07-10T12:05:00.000Z', last_seen_at: '2026-07-10T12:05:00.000Z' }, run).action, 'unchanged');
    const changed = makeListing({ title: 'Updated apartment title', scraped_at: '2026-07-10T12:10:00.000Z', last_seen_at: '2026-07-10T12:10:00.000Z' });
    assert.equal(storage.upsertListing(changed, run).action, 'updated');
    assert.equal(storage.getListings().length, 1);
    assert.equal(storage.getListings()[0].first_seen_at, first.first_seen_at);
    assert.equal(storage.report().versions, 2);
  } finally {
    storage.close();
  }
});

test('checkpoint can resume and be cleared', () => {
  const storage = createStorage();
  try {
    storage.saveCheckpoint('estate_am', 'default', {
      cursor: '2', pageNumber: 2, recordsSeen: 30, payload: { itemOffset: 4 },
    });
    assert.deepEqual(storage.getCheckpoint('estate_am').payload, { itemOffset: 4 });
    assert.equal(storage.getCheckpoint('estate_am').cursor, '2');
    storage.clearCheckpoint('estate_am');
    assert.equal(storage.getCheckpoint('estate_am'), null);
  } finally {
    storage.close();
  }
});

test('records strong cross-source matches without merging rows', () => {
  const storage = createStorage();
  try {
    const first = storage.upsertListing(makeListing(), 'run-a');
    const secondListing = makeListing({
      source: 'facebook_groups',
      source_type: 'facebook_group',
      source_group_url: 'https://www.facebook.com/share/g/1HPB7PQP1R',
      source_listing_id: null,
      source_post_id: '9001',
      source_url: 'https://www.facebook.com/groups/123/posts/9001',
      canonical_url: 'https://www.facebook.com/groups/123/posts/9001',
      contact_url: 'https://www.facebook.com/groups/123/posts/9001',
    });
    const second = storage.upsertListing(secondListing, 'run-b');
    const matches = storage.recordCrossSourceDuplicates(second.id);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].classification, 'high_confidence_match');
    assert.equal(storage.getListings().length, 2);
    assert.equal(first.id !== second.id, true);
  } finally {
    storage.close();
  }
});

test('complete snapshots mark missing records inactive and then deleted', () => {
  const storage = createStorage();
  try {
    storage.upsertListing(makeListing(), 'seen-run');
    storage.finalizeCompleteSnapshot('estate_am', 'miss-1', 3);
    assert.equal(storage.getListings()[0].status, 'inactive');
    storage.finalizeCompleteSnapshot('estate_am', 'miss-2', 3);
    storage.finalizeCompleteSnapshot('estate_am', 'miss-3', 3);
    assert.equal(storage.getListings()[0].status, 'deleted');
    assert.equal(storage.upsertListing(makeListing({ scraped_at: '2026-07-11T12:00:00.000Z', last_seen_at: '2026-07-11T12:00:00.000Z' }), 'seen-again').action, 'updated');
    assert.equal(storage.getListings()[0].status, 'active');
    assert.equal(storage.report().versions, 4);
  } finally {
    storage.close();
  }
});

test('configuration sync preserves a runtime blocked status until a successful run resets it', () => {
  const storage = createStorage();
  try {
    const config = loadAggregatorConfig();
    storage.updateSourceStatus('estate_am', 'blocked', 'challenge detected');
    storage.syncConfiguration(config, loadFacebookGroups(config));
    let source = storage.report().sources.find((item) => item.name === 'estate_am');
    assert.equal(source.status, 'blocked');
    assert.equal(source.status_reason, 'challenge detected');
    storage.updateSourceStatus('estate_am', config.sources.estate_am.status, config.sources.estate_am.reason);
    source = storage.report().sources.find((item) => item.name === 'estate_am');
    assert.equal(source.status, 'partially_supported');
  } finally {
    storage.close();
  }
});

test('bounded catalog search supports structured filters, text, sorting, and database ids', () => {
  const storage = createStorage();
  try {
    storage.upsertListing(makeListing({ source_listing_id: '1001', price_value: 120000 }), 'run');
    storage.upsertListing(makeListing({
      source_listing_id: '1002',
      canonical_url: 'https://www.estate.am/en/example-d1002',
      source_url: 'https://www.estate.am/en/example-d1002',
      contact_url: 'https://www.estate.am/en/example-d1002',
      district: 'Kentron',
      title: 'Compact apartment in Kentron',
      description: 'Apartment near Republic Square',
      raw_text: 'Apartment near Republic Square, 55 m2, 2 rooms, 90000 USD',
      area_m2: 55,
      rooms: 2,
      price_value: 90000,
    }), 'run');

    const result = storage.searchListings({
      query: 'Republic Square',
      propertyType: 'apartment',
      priceMax: 100000,
      sort: 'price_asc',
      limit: 10,
    });
    assert.equal(result.total, 1);
    assert.equal(result.count, 1);
    assert.equal(result.listings[0].district, 'Kentron');
    assert.equal(Number.isInteger(result.listings[0].database_id), true);
    assert.equal(storage.getListingById(result.listings[0].database_id).source_listing_id, '1002');
  } finally {
    storage.close();
  }
});

test('exports combined JSONL and CSV and validates stored rows', () => {
  const storage = createStorage();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aggregator-export-'));
  try {
    storage.upsertListing(makeListing(), 'run');
    const jsonFiles = exportListings(storage, { format: 'jsonl', outputDirectory: directory });
    const csvFiles = exportListings(storage, { format: 'csv', outputDirectory: directory });
    assert.equal(jsonFiles[0].count, 1);
    assert.equal(JSON.parse(fs.readFileSync(jsonFiles[0].path, 'utf8').trim()).source, 'estate_am');
    assert.match(fs.readFileSync(csvFiles[0].path, 'utf8'), /^source,source_type,/);
    assert.deepEqual(storage.validateStoredListings(), { total: 1, valid: 1, invalid: [] });
  } finally {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
