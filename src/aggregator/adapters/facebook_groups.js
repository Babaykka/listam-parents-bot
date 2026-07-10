'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalizeUrl } = require('../canonical');
const { PARSER_VERSION } = require('../constants');
const { AccessPolicyError } = require('../errors');
const { buildListingFingerprint } = require('../fingerprint');
const {
  detectLanguage,
  detectListingKind,
  detectOperationType,
  detectPropertyType,
  detectSellerType,
  normalizeCity,
  normalizeDistrict,
  normalizeSpaces,
  parseArea,
  parseFloor,
  parseLandArea,
  parsePrice,
  parseRooms,
  toIsoDate,
} = require('../normalization');
const { SourceAdapter } = require('./base');

function parseCsv(value) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function readImportRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (path.extname(filePath).toLowerCase() === '.csv') return parseCsv(raw);
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function parseImageUrls(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && /^https?:\/\//i.test(item));
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      return parseImageUrls(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  return trimmed.split(';').map((item) => item.trim()).filter((item) => /^https?:\/\//i.test(item));
}

function findCity(text) {
  const match = text.match(/Yerevan|Erevan|Ереван|Երևան|Երեւան|Abovyan|Абовян|Աբովյան/iu);
  return match ? normalizeCity(match[0]) : null;
}

function findDistrict(text) {
  const match = text.match(/Kentron|Center|Downtown|Центр|Կենտրոն|Arabkir|Арабкир|Արաբկիր|Ajapnyak|Ачапняк|Աջափնյակ|Avan|Аван|Ավան|Nor Nork|Нор Норк|Նոր Նորք/iu);
  return match ? normalizeDistrict(match[0]) : null;
}

function isRelevantRealEstatePost(row, text, images) {
  if (row.is_real_estate === true || String(row.is_real_estate).toLowerCase() === 'true') return true;
  if (!text && images.length) return false;
  return /(apartment|house|villa|land|office|garage|rent|sale|квартир|дом|земл|офис|гараж|аренд|прод|բնակարան|տուն|հող|գրասենյակ|վարձ|վաճառ)/iu.test(text);
}

function redactContacts(value) {
  return normalizeSpaces(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/(?:\+?374|0)[\s().-]*\d{2}(?:[\s().-]*\d){6}/g, '[redacted phone]');
}

function parseFacebookRow(row, groups, now = new Date().toISOString()) {
  const sourceText = normalizeSpaces(row.text || row.message || row.description || '');
  const images = parseImageUrls(row.image_urls || row.images);
  if (!isRelevantRealEstatePost(row, sourceText, images)) return null;
  const text = redactContacts(sourceText);
  const allowedDomains = ['facebook.com', 'www.facebook.com', 'm.facebook.com'];
  const groupUrlInput = row.group_url || row.source_group_url;
  const postUrlInput = row.post_url || row.source_url;
  if (!groupUrlInput || !postUrlInput) throw new Error('Facebook import row requires group_url and post_url.');
  const groupUrl = canonicalizeUrl(groupUrlInput, allowedDomains);
  const acceptedGroups = new Set(groups.flatMap((group) => [group.share_url, group.canonical_url].filter(Boolean).map((url) => canonicalizeUrl(url, allowedDomains))));
  if (!acceptedGroups.has(groupUrl)) throw new Error(`Facebook group is not configured: ${groupUrl}`);
  const canonicalUrl = canonicalizeUrl(postUrlInput, allowedDomains);
  const sourcePostId = String(row.post_id || canonicalUrl.match(/\/(?:posts|permalink)\/(\d+)/i)?.[1] || '').trim() || null;
  const propertyType = detectPropertyType(text, 'other');
  const operationType = detectOperationType(text, 'unknown');
  const listingKind = detectListingKind(text);
  const price = parsePrice(text);
  const floor = parseFloor(text);
  const publishedAt = toIsoDate(row.created_at || row.published_at || row.date);
  const requiresReview = !text || propertyType === 'other' || operationType === 'unknown';
  const listing = {
    source: 'facebook_groups',
    source_type: 'facebook_group',
    source_group_url: groupUrl,
    source_url: canonicalUrl,
    canonical_url: canonicalUrl,
    source_listing_id: null,
    source_post_id: sourcePostId,
    listing_fingerprint: '0'.repeat(64),
    listing_kind: listingKind,
    operation_type: operationType,
    property_type: propertyType,
    title: text ? text.slice(0, 160) : 'Image-only post requiring review',
    description: text || null,
    language: detectLanguage(text),
    ...price,
    country: 'Armenia',
    region: null,
    city: findCity(text),
    district: findDistrict(text),
    address_raw: null,
    latitude: null,
    longitude: null,
    rooms: parseRooms(text),
    bedrooms: null,
    bathrooms: null,
    area_m2: parseArea(text),
    land_area_m2: parseLandArea(text),
    floor: floor.floor,
    floors_total: floor.floors_total,
    building_type: null,
    condition: null,
    year_built: null,
    amenities: [],
    image_urls: images,
    seller_type: detectSellerType(text),
    seller_display_name: row.seller_is_business === true ? normalizeSpaces(row.seller_display_name) || null : null,
    contact_phone: null,
    contact_url: canonicalUrl,
    published_at: publishedAt,
    updated_at: null,
    first_seen_at: now,
    last_seen_at: now,
    scraped_at: now,
    status: 'active',
    raw_text: text || null,
    raw_payload: {
      group_url: groupUrl,
      post_url: canonicalUrl,
      post_id: sourcePostId,
      text: text || null,
      created_at: row.created_at || row.published_at || row.date || null,
      image_urls: images,
      is_real_estate: row.is_real_estate === true || String(row.is_real_estate).toLowerCase() === 'true',
    },
    validation_errors: [],
    requires_review: requiresReview,
    parser_version: PARSER_VERSION,
  };
  if (!sourcePostId) listing.validation_errors.push('stable Facebook post ID is missing');
  if (!publishedAt) listing.validation_errors.push('publication date is missing or ambiguous');
  if (requiresReview) listing.validation_errors.push('post requires manual review');
  listing.listing_fingerprint = buildListingFingerprint(listing);
  return listing;
}

class FacebookGroupsAdapter extends SourceAdapter {
  constructor(name, config, groups) {
    super(name, config);
    this.groups = groups;
  }

  async *pages(context) {
    if (!context.inputFile) {
      throw new AccessPolicyError(
        'Live Facebook collection is disabled without Meta written permission. Provide a permitted JSONL or CSV export with --input.',
        'partially_supported',
      );
    }
    const rows = readImportRows(context.inputFile);
    const startIndex = Number(context.resumeCursor || 0);
    const chunkSize = 100;
    const endIndex = Math.min(rows.length, startIndex + (context.maxPages * chunkSize));
    for (let index = startIndex; index < endIndex; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      const items = chunk.map((row) => parseFacebookRow(row, this.groups, context.now())).filter(Boolean);
      const nextIndex = index + chunk.length;
      yield {
        items,
        pageNumber: Math.floor(index / chunkSize) + 1,
        cursor: nextIndex < rows.length ? String(nextIndex) : null,
        complete: nextIndex >= rows.length,
        sourceUrl: context.inputFile,
        fromCache: false,
      };
    }
  }
}

module.exports = {
  FacebookGroupsAdapter,
  isRelevantRealEstatePost,
  parseCsv,
  parseFacebookRow,
  redactContacts,
  readImportRows,
};
