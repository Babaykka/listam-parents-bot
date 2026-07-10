'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseEstateFeed } = require('../../src/aggregator/adapters/estate_am');
const { parseFacebookRow, readImportRows, redactContacts } = require('../../src/aggregator/adapters/facebook_groups');
const { ListAmAdapter } = require('../../src/aggregator/adapters/list_am');
const { loadAggregatorConfig, loadFacebookGroups } = require('../../src/aggregator/config');
const { AccessPolicyError } = require('../../src/aggregator/errors');
const { safeValidateListing } = require('../../src/aggregator/schema');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('extracts deterministic Estate fields from official Atom feed', () => {
  const xml = fs.readFileSync(fixture('estate-sale.xml'), 'utf8');
  const listings = parseEstateFeed(xml, { operation_type: 'sale', property_type: 'apartment' }, '2026-07-10T12:00:00.000Z');
  assert.equal(listings.length, 2);
  assert.equal(listings[0].source_listing_id, '120001');
  assert.equal(listings[0].canonical_url, 'https://www.estate.am/en/3-rooms-apartment-for-sale-in-arabkir-yerevan-d120001');
  assert.equal(listings[0].price_value, 120000);
  assert.equal(listings[0].currency, 'USD');
  assert.equal(listings[0].area_m2, 75);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].district, 'Arabkir');
  assert.equal(listings[0].published_at, null);
  assert.equal(listings[0].updated_at, '2026-07-09T08:15:00.000Z');
  assert.equal(safeValidateListing(listings[0]).success, true);
});

test('extracts rental operation and AMD from Estate feed', () => {
  const xml = fs.readFileSync(fixture('estate-rent.xml'), 'utf8');
  const [listing] = parseEstateFeed(xml, { operation_type: 'long_term_rent', property_type: 'house' }, '2026-07-10T12:00:00.000Z');
  assert.equal(listing.operation_type, 'long_term_rent');
  assert.equal(listing.property_type, 'house');
  assert.equal(listing.price_value, 650000);
  assert.equal(listing.currency, 'AMD');
});

test('imports multilingual Facebook rows without collecting personal contacts', () => {
  const config = loadAggregatorConfig();
  const groups = loadFacebookGroups(config);
  const rows = readImportRows(fixture('facebook-import.jsonl'));
  const listings = rows.map((row) => parseFacebookRow(row, groups, '2026-07-10T12:00:00.000Z'));
  assert.deepEqual(listings.map((listing) => listing.language), ['ru', 'hy', 'en']);
  assert.equal(listings[0].contact_phone, null);
  assert.equal(listings[0].operation_type, 'sale');
  assert.equal(listings[1].operation_type, 'long_term_rent');
  assert.equal(listings[2].listing_kind, 'wanted');
  assert.equal(listings.every((listing) => safeValidateListing(listing).success), true);
});

test('skips irrelevant Facebook text and flags declared image-only property posts', () => {
  const groups = loadFacebookGroups(loadAggregatorConfig());
  const base = {
    group_url: groups[0].share_url,
    post_url: 'https://www.facebook.com/groups/123/posts/9999/',
    post_id: '9999',
  };
  assert.equal(parseFacebookRow({ ...base, text: 'Community picnic on Sunday' }, groups), null);
  const imageOnly = parseFacebookRow({ ...base, text: '', image_urls: ['https://example.test/home.jpg'], is_real_estate: true }, groups);
  assert.equal(imageOnly.requires_review, true);
  assert.equal(imageOnly.property_type, 'other');
});

test('rejects an imported Facebook group outside the configured 22 groups', () => {
  const groups = loadFacebookGroups(loadAggregatorConfig());
  assert.throws(() => parseFacebookRow({
    group_url: 'https://www.facebook.com/groups/not-configured',
    post_url: 'https://www.facebook.com/groups/not-configured/posts/1',
    text: 'Apartment for sale',
    is_real_estate: true,
  }, groups), /not configured/);
});

test('policy-gated website adapter stops before yielding or fetching a page', async () => {
  const source = loadAggregatorConfig().sources.list_am;
  const adapter = new ListAmAdapter('list_am', source);
  await assert.rejects(() => adapter.pages({}).next(), AccessPolicyError);
});

test('Facebook import redacts contact details and drops arbitrary raw fields', () => {
  assert.equal(redactContacts('Call +374 91 123456 or test@example.com'), 'Call [redacted phone] or [redacted email]');
  const groups = loadFacebookGroups(loadAggregatorConfig());
  const listing = parseFacebookRow({
    group_url: groups[0].share_url,
    post_url: 'https://www.facebook.com/groups/123/posts/5555/',
    post_id: '5555',
    text: 'Apartment for sale in Yerevan, 75 m2, 120000 USD, +374 91 123456',
    hidden_profile_data: 'must not persist',
    is_real_estate: true,
  }, groups);
  assert.doesNotMatch(listing.raw_text, /123456/);
  assert.equal(Object.hasOwn(listing.raw_payload, 'hidden_profile_data'), false);
});
