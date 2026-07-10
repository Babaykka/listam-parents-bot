'use strict';

const { z } = require('zod');
const {
  LISTING_KINDS,
  LISTING_STATUSES,
  OPERATION_TYPES,
  PROPERTY_TYPES,
  SELLER_TYPES,
  SOURCE_TYPES,
} = require('./constants');

const nullableText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().nullable(),
);
const nullableUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().url().nullable(),
);
const nullableNumber = z.number().finite().nullable();
const nullableNonNegative = z.number().finite().nonnegative().nullable();
const nullableInteger = z.number().int().nullable();
const nullableDateTime = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().datetime({ offset: true }).nullable(),
);

const ListingSchema = z.object({
  source: z.string().min(1),
  source_type: z.enum(SOURCE_TYPES),
  source_group_url: nullableUrl.default(null),
  source_url: z.string().url(),
  canonical_url: z.string().url(),
  source_listing_id: nullableText.default(null),
  source_post_id: nullableText.default(null),
  listing_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  listing_kind: z.enum(LISTING_KINDS).default('unknown'),
  operation_type: z.enum(OPERATION_TYPES).default('unknown'),
  property_type: z.enum(PROPERTY_TYPES).default('other'),
  title: nullableText.default(null),
  description: nullableText.default(null),
  language: z.enum(['hy', 'ru', 'en', 'unknown']).default('unknown'),
  price_raw: nullableText.default(null),
  price_value: nullableNonNegative.default(null),
  currency: z.enum(['AMD', 'USD', 'EUR', 'RUB']).nullable().default(null),
  price_on_request: z.boolean().default(false),
  country: nullableText.default('Armenia'),
  region: nullableText.default(null),
  city: nullableText.default(null),
  district: nullableText.default(null),
  address_raw: nullableText.default(null),
  latitude: nullableNumber.refine((value) => value === null || (value >= -90 && value <= 90)).default(null),
  longitude: nullableNumber.refine((value) => value === null || (value >= -180 && value <= 180)).default(null),
  rooms: nullableNonNegative.default(null),
  bedrooms: nullableNonNegative.default(null),
  bathrooms: nullableNonNegative.default(null),
  area_m2: nullableNonNegative.default(null),
  land_area_m2: nullableNonNegative.default(null),
  floor: nullableInteger.default(null),
  floors_total: nullableInteger.default(null),
  building_type: nullableText.default(null),
  condition: nullableText.default(null),
  year_built: nullableInteger.refine((value) => value === null || (value >= 1700 && value <= 2200)).default(null),
  amenities: z.array(z.string().min(1)).default([]),
  image_urls: z.array(z.string().url()).default([]),
  seller_type: z.enum(SELLER_TYPES).default('unknown'),
  seller_display_name: nullableText.default(null),
  contact_phone: nullableText.default(null),
  contact_url: nullableUrl.default(null),
  published_at: nullableDateTime.default(null),
  updated_at: nullableDateTime.default(null),
  first_seen_at: z.string().datetime({ offset: true }),
  last_seen_at: z.string().datetime({ offset: true }),
  scraped_at: z.string().datetime({ offset: true }),
  status: z.enum(LISTING_STATUSES).default('active'),
  raw_text: nullableText.default(null),
  raw_payload: z.record(z.string(), z.unknown()).nullable().default(null),
  validation_errors: z.array(z.string()).default([]),
  requires_review: z.boolean().default(false),
  parser_version: z.string().min(1),
}).strict();

function validateListing(value) {
  return ListingSchema.parse(value);
}

function safeValidateListing(value) {
  return ListingSchema.safeParse(value);
}

module.exports = { ListingSchema, safeValidateListing, validateListing };
