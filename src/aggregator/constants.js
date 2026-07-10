'use strict';

const SOURCE_STATUSES = [
  'supported',
  'partially_supported',
  'blocked',
  'requires_manual_login',
  'not_permitted',
  'temporarily_unavailable',
];

const LISTING_KINDS = ['offer', 'wanted', 'unknown'];
const OPERATION_TYPES = [
  'sale',
  'long_term_rent',
  'short_term_rent',
  'daily_rent',
  'exchange',
  'unknown',
];
const PROPERTY_TYPES = [
  'apartment',
  'house',
  'townhouse',
  'land',
  'commercial',
  'office',
  'garage',
  'room',
  'other',
];
const SELLER_TYPES = ['owner', 'agency', 'developer', 'unknown'];
const LISTING_STATUSES = ['active', 'inactive', 'deleted', 'unknown'];
const SOURCE_TYPES = ['website', 'facebook_group'];
const PARSER_VERSION = 'aggregator-1.0.0';

module.exports = {
  LISTING_KINDS,
  LISTING_STATUSES,
  OPERATION_TYPES,
  PARSER_VERSION,
  PROPERTY_TYPES,
  SELLER_TYPES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
};
