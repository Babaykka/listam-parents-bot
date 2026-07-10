'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LISTING_COLUMNS } = require('./storage');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCsv(listings) {
  const lines = [LISTING_COLUMNS.map(csvEscape).join(',')];
  for (const listing of listings) {
    lines.push(LISTING_COLUMNS.map((column) => csvEscape(listing[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function serializeJsonl(listings) {
  return listings.length ? `${listings.map((listing) => JSON.stringify(listing)).join('\n')}\n` : '';
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function exportListings(storage, options) {
  const format = options.format;
  if (!['jsonl', 'csv'].includes(format)) throw new Error(`Unsupported export format: ${format}`);
  const outputDirectory = path.resolve(options.outputDirectory);
  const all = storage.getListings(options.source ? { source: options.source } : {});
  const serialize = format === 'csv' ? serializeCsv : serializeJsonl;
  const scope = options.source || 'all';
  const combinedPath = path.join(outputDirectory, `listings-${scope}.${format}`);
  atomicWrite(combinedPath, serialize(all));
  const files = [{ path: combinedPath, count: all.length }];

  if (options.splitBySource !== false && !options.source) {
    const sources = [...new Set(all.map((listing) => listing.source))].sort();
    for (const source of sources) {
      const listings = all.filter((listing) => listing.source === source);
      const filePath = path.join(outputDirectory, `listings-${source}.${format}`);
      atomicWrite(filePath, serialize(listings));
      files.push({ path: filePath, count: listings.length });
    }
  }
  return files;
}

module.exports = { atomicWrite, csvEscape, exportListings, serializeCsv, serializeJsonl };
