'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadAggregatorConfig, loadFacebookGroups } = require('../config');
const { buildDiscoveryReport } = require('../discovery');
const { exportListings } = require('../exporter');
const { AggregatorRunner } = require('../runner');
const { AggregatorStorage } = require('../storage');

function publicListing(listing) {
  if (!listing) return null;
  const result = { ...listing };
  delete result.raw_payload;
  return result;
}

function positiveInteger(value, fallback, maximum) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`Expected a positive integer no greater than ${maximum}.`);
  }
  return number;
}

function resolveFacebookImport(config, filename) {
  if (!filename) return undefined;
  if (path.isAbsolute(filename)) throw new Error('Facebook import must be a filename relative to data/imports.');
  const importDirectory = path.resolve(config.project_root, 'data/imports');
  const candidate = path.resolve(importDirectory, filename);
  if (candidate !== importDirectory && !candidate.startsWith(`${importDirectory}${path.sep}`)) {
    throw new Error('Facebook import path leaves data/imports.');
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`Facebook import file does not exist: ${path.relative(config.project_root, candidate)}`);
  }
  if (!['.jsonl', '.csv'].includes(path.extname(candidate).toLowerCase())) {
    throw new Error('Facebook import must be a .jsonl or .csv file.');
  }
  return candidate;
}

class AggregatorMcpService {
  constructor(options = {}) {
    this.config = options.config || loadAggregatorConfig(options.configPath);
    this.groups = options.groups || loadFacebookGroups(this.config);
    this.storage = options.storage || new AggregatorStorage(this.config.database_path);
    this.ownsStorage = !options.storage;
    this.storage.syncConfiguration(this.config, this.groups);
    this.runner = options.runner || new AggregatorRunner(this.config, this.storage);
  }

  listSources() {
    const report = this.storage.report();
    const counts = new Map();
    for (const row of report.listings) {
      const entry = counts.get(row.source) || { total: 0, active: 0, inactive: 0, deleted: 0, unknown: 0 };
      entry.total += row.count;
      entry[row.status] = (entry[row.status] || 0) + row.count;
      counts.set(row.source, entry);
    }
    return {
      sources: report.sources.map((source) => ({
        ...source,
        base_url: this.config.sources[source.name]?.base_url || null,
        listing_counts: counts.get(source.name) || { total: 0, active: 0, inactive: 0, deleted: 0, unknown: 0 },
      })),
      facebook_groups: {
        configured: this.groups.length,
        statuses: report.facebook_groups,
      },
    };
  }

  discovery() {
    return buildDiscoveryReport(this.config, this.groups);
  }

  report() {
    return this.storage.report();
  }

  search(filters = {}) {
    const result = this.storage.searchListings({
      ...filters,
      limit: positiveInteger(filters.limit, 50, 500),
      offset: Math.max(Number(filters.offset) || 0, 0),
    });
    return { ...result, listings: result.listings.map(publicListing) };
  }

  getListing(databaseId) {
    return publicListing(this.storage.getListingById(positiveInteger(databaseId, null, Number.MAX_SAFE_INTEGER)));
  }

  async crawl(options = {}) {
    const source = String(options.source || '').trim();
    const allowedSources = new Set([...Object.keys(this.config.sources), 'all']);
    if (!allowedSources.has(source)) throw new Error(`Unknown source: ${source}`);
    const inputFile = source === 'facebook_groups'
      ? resolveFacebookImport(this.config, options.facebookImportFile)
      : undefined;
    if (options.facebookImportFile && source !== 'facebook_groups') {
      throw new Error('facebook_import_file is only valid for source facebook_groups.');
    }
    const crawlOptions = {
      resume: Boolean(options.resume),
      dryRun: Boolean(options.dryRun),
      maxPages: positiveInteger(options.maxPages, this.config.defaults.max_pages, 100),
      maxRecords: positiveInteger(options.maxRecords, this.config.defaults.max_records, 10000),
      inputFile,
    };
    if (!crawlOptions.dryRun) {
      return source === 'all'
        ? this.runner.crawlAll(crawlOptions)
        : this.runner.crawlSource(source, crawlOptions);
    }

    const dryStorage = new AggregatorStorage(':memory:');
    dryStorage.syncConfiguration(this.config, this.groups);
    const dryRunner = new AggregatorRunner(this.config, dryStorage);
    try {
      return source === 'all'
        ? await dryRunner.crawlAll(crawlOptions)
        : await dryRunner.crawlSource(source, crawlOptions);
    } finally {
      dryStorage.close();
    }
  }

  export(options = {}) {
    const source = options.source || null;
    if (source && !this.config.sources[source]) throw new Error(`Unknown source: ${source}`);
    const format = options.format || 'jsonl';
    if (!['jsonl', 'csv'].includes(format)) throw new Error(`Unsupported export format: ${format}`);
    return {
      files: exportListings(this.storage, {
        format,
        source,
        outputDirectory: this.config.export_directory,
        splitBySource: options.splitBySource !== false,
      }).map((file) => ({
        ...file,
        path: path.relative(this.config.project_root, file.path),
      })),
    };
  }

  close() {
    if (this.ownsStorage) this.storage.close();
  }
}

module.exports = {
  AggregatorMcpService,
  positiveInteger,
  publicListing,
  resolveFacebookImport,
};
