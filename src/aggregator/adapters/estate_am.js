'use strict';

const { XMLParser } = require('fast-xml-parser');
const { canonicalizeUrl } = require('../canonical');
const { PARSER_VERSION } = require('../constants');
const { buildListingFingerprint } = require('../fingerprint');
const {
  detectOperationType,
  detectPropertyType,
  inferAmenities,
  inferCondition,
  normalizeCity,
  normalizeDistrict,
  normalizeSpaces,
  parseArea,
  parseFloor,
  parsePrice,
  parseRooms,
  stripHtml,
  toIsoDate,
} = require('../normalization');
const { SourceAdapter } = require('./base');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  trimValues: true,
});

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value['#text'] || value.__cdata || '');
}

function linkByRel(entry, rel) {
  return asArray(entry.link).find((link) => link?.['@_rel'] === rel)?.['@_href'] || null;
}

function parseEstateSummary(summary) {
  const pieces = summary.split(',').map((part) => normalizeSpaces(part)).filter(Boolean);
  const areaIndex = pieces.findIndex((part) => parseArea(part) !== null);
  const city = pieces[0] ? normalizeCity(pieces[0]) : null;
  const district = pieces[1] ? normalizeDistrict(pieces[1]) : null;
  const addressRaw = areaIndex > 2 ? pieces.slice(2, areaIndex).join(', ') : pieces[2] && areaIndex !== 2 ? pieces[2] : null;
  return { city, district, addressRaw };
}

function parseEstateEntry(entry, feedConfig, now = new Date().toISOString()) {
  const title = normalizeSpaces(textValue(entry.title));
  const summary = normalizeSpaces(textValue(entry.summary));
  const description = stripHtml(textValue(entry.content));
  const alternateUrl = linkByRel(entry, 'alternate') || textValue(entry.id);
  const canonicalUrl = canonicalizeUrl(alternateUrl, ['estate.am', 'www.estate.am']);
  const sourceListingId = canonicalUrl.match(/-d(\d+)(?:$|[/?#])/i)?.[1] || null;
  const imageUrl = linkByRel(entry, 'enclosure');
  const rawText = normalizeSpaces(`${title} ${summary} ${description}`);
  const titlePrice = title.match(/\s+-\s+(.+)$/u)?.[1] || summary;
  const price = parsePrice(titlePrice);
  const location = parseEstateSummary(summary);
  const floor = parseFloor(summary);
  const operationType = detectOperationType(`${canonicalUrl} ${title} ${description}`, feedConfig.operation_type);
  const listing = {
    source: 'estate_am',
    source_type: 'website',
    source_group_url: null,
    source_url: canonicalUrl,
    canonical_url: canonicalUrl,
    source_listing_id: sourceListingId,
    source_post_id: null,
    listing_fingerprint: '0'.repeat(64),
    listing_kind: 'offer',
    operation_type: operationType,
    property_type: detectPropertyType(`${title} ${summary}`, feedConfig.property_type),
    title: title || null,
    description: description || null,
    language: 'en',
    ...price,
    country: 'Armenia',
    region: null,
    city: location.city,
    district: location.district,
    address_raw: location.addressRaw,
    latitude: null,
    longitude: null,
    rooms: parseRooms(summary),
    bedrooms: null,
    bathrooms: null,
    area_m2: parseArea(summary),
    land_area_m2: null,
    floor: floor.floor,
    floors_total: floor.floors_total,
    building_type: null,
    condition: inferCondition(description),
    year_built: null,
    amenities: inferAmenities(description),
    image_urls: imageUrl ? [imageUrl] : [],
    seller_type: 'unknown',
    seller_display_name: null,
    contact_phone: null,
    contact_url: canonicalUrl,
    published_at: null,
    updated_at: toIsoDate(textValue(entry.updated)),
    first_seen_at: now,
    last_seen_at: now,
    scraped_at: now,
    status: 'active',
    raw_text: rawText || null,
    raw_payload: entry,
    validation_errors: [],
    requires_review: false,
    parser_version: PARSER_VERSION,
  };
  if (!sourceListingId) listing.validation_errors.push('stable source listing ID is missing');
  if (operationType === 'unknown') listing.validation_errors.push('operation is ambiguous in the feed entry');
  if (price.price_value === null && !price.price_on_request) listing.validation_errors.push('price could not be parsed');
  listing.requires_review = listing.validation_errors.length > 0;
  listing.listing_fingerprint = buildListingFingerprint(listing);
  return listing;
}

function parseEstateFeed(xml, feedConfig, now = new Date().toISOString()) {
  const parsed = xmlParser.parse(xml);
  const feed = parsed.feed;
  if (!feed) throw new Error('Estate.am response is not an Atom feed.');
  return asArray(feed.entry).map((entry) => parseEstateEntry(entry, feedConfig, now));
}

class EstateAmAdapter extends SourceAdapter {
  async *pages(context) {
    const startIndex = Number(context.resumeCursor || 0);
    const endIndex = Math.min(this.config.feeds.length, startIndex + context.maxPages);
    for (let index = startIndex; index < endIndex; index += 1) {
      const feedConfig = this.config.feeds[index];
      const response = await context.transport.getText(feedConfig.url, {
        accept: 'application/atom+xml, application/xml, text/xml',
      });
      const items = parseEstateFeed(response.body, feedConfig, context.now());
      yield {
        items,
        pageNumber: index + 1,
        cursor: index + 1 < this.config.feeds.length ? String(index + 1) : null,
        complete: index + 1 >= this.config.feeds.length,
        sourceUrl: feedConfig.url,
        fromCache: response.fromCache,
      };
    }
  }
}

module.exports = { EstateAmAdapter, parseEstateEntry, parseEstateFeed, parseEstateSummary };
