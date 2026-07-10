'use strict';

const crypto = require('node:crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function compactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 600);
}

function buildListingFingerprint(listing) {
  return hash({
    operation_type: listing.operation_type || null,
    property_type: listing.property_type || null,
    city: compactText(listing.city),
    district: compactText(listing.district),
    address: compactText(listing.address_raw),
    area_m2: listing.area_m2 ?? null,
    land_area_m2: listing.land_area_m2 ?? null,
    rooms: listing.rooms ?? null,
    floor: listing.floor ?? null,
    price_value: listing.price_value ?? null,
    currency: listing.currency || null,
    text: compactText(`${listing.title || ''} ${listing.description || ''}`),
  });
}

function buildSourceIdentity(listing) {
  if (listing.source_listing_id) return `${listing.source}:listing:${listing.source_listing_id}`;
  if (listing.source_post_id) return `${listing.source}:post:${listing.source_post_id}`;
  if (listing.canonical_url) return `${listing.source}:url:${listing.canonical_url}`;
  return `${listing.source}:fingerprint:${listing.listing_fingerprint}`;
}

const CONTENT_HASH_OMIT = new Set([
  'first_seen_at',
  'last_seen_at',
  'scraped_at',
  'listing_fingerprint',
]);

function buildContentHash(listing) {
  const versioned = Object.fromEntries(
    Object.entries(listing).filter(([key]) => !CONTENT_HASH_OMIT.has(key)),
  );
  return hash(versioned);
}

module.exports = {
  buildContentHash,
  buildListingFingerprint,
  buildSourceIdentity,
  compactText,
  hash,
  stableValue,
};
