'use strict';

const { PARSER_VERSION } = require('../../src/aggregator/constants');
const { buildListingFingerprint } = require('../../src/aggregator/fingerprint');

function makeListing(overrides = {}) {
  const now = overrides.scraped_at || '2026-07-10T12:00:00.000Z';
  const source = overrides.source || 'estate_am';
  const id = String(overrides.source_listing_id || overrides.source_post_id || '1001');
  const isFacebook = overrides.source_type === 'facebook_group' || source === 'facebook_groups';
  const canonical = overrides.canonical_url || (isFacebook
    ? `https://www.facebook.com/groups/123/posts/${id}`
    : `https://www.estate.am/en/example-d${id}`);
  const listing = {
    source,
    source_type: isFacebook ? 'facebook_group' : 'website',
    source_group_url: isFacebook ? 'https://www.facebook.com/share/g/1HPB7PQP1R' : null,
    source_url: canonical,
    canonical_url: canonical,
    source_listing_id: isFacebook ? null : id,
    source_post_id: isFacebook ? id : null,
    listing_fingerprint: '0'.repeat(64),
    listing_kind: 'offer',
    operation_type: 'sale',
    property_type: 'apartment',
    title: 'Apartment in Arabkir',
    description: 'Renovated apartment on Komitas Avenue with balcony and elevator.',
    language: 'en',
    price_raw: '120,000 USD',
    price_value: 120000,
    currency: 'USD',
    price_on_request: false,
    country: 'Armenia',
    region: null,
    city: 'Yerevan',
    district: 'Arabkir',
    address_raw: 'Komitas Ave.',
    latitude: null,
    longitude: null,
    rooms: 3,
    bedrooms: 2,
    bathrooms: 1,
    area_m2: 75,
    land_area_m2: null,
    floor: 4,
    floors_total: 9,
    building_type: null,
    condition: 'renovated',
    year_built: null,
    amenities: ['balcony', 'elevator'],
    image_urls: [],
    seller_type: 'unknown',
    seller_display_name: null,
    contact_phone: null,
    contact_url: canonical,
    published_at: null,
    updated_at: '2026-07-09T08:15:00.000Z',
    first_seen_at: now,
    last_seen_at: now,
    scraped_at: now,
    status: 'active',
    raw_text: 'Apartment in Arabkir, 75 m2, 3 rooms, 120,000 USD',
    raw_payload: { fixture: true },
    validation_errors: [],
    requires_review: false,
    parser_version: PARSER_VERSION,
    ...overrides,
  };
  listing.listing_fingerprint = buildListingFingerprint(listing);
  return listing;
}

module.exports = { makeListing };
