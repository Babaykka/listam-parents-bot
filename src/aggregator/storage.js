'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { compareListings } = require('./deduplicator');
const { buildContentHash, buildSourceIdentity, stableValue } = require('./fingerprint');
const { safeValidateListing, validateListing } = require('./schema');

const LISTING_COLUMNS = [
  'source', 'source_type', 'source_group_url', 'source_url', 'canonical_url',
  'source_listing_id', 'source_post_id', 'listing_fingerprint', 'listing_kind',
  'operation_type', 'property_type', 'title', 'description', 'language',
  'price_raw', 'price_value', 'currency', 'price_on_request', 'country', 'region',
  'city', 'district', 'address_raw', 'latitude', 'longitude', 'rooms', 'bedrooms',
  'bathrooms', 'area_m2', 'land_area_m2', 'floor', 'floors_total', 'building_type',
  'condition', 'year_built', 'amenities', 'image_urls', 'seller_type',
  'seller_display_name', 'contact_phone', 'contact_url', 'published_at', 'updated_at',
  'first_seen_at', 'last_seen_at', 'scraped_at', 'status', 'raw_text', 'raw_payload',
  'validation_errors', 'requires_review', 'parser_version',
];
const JSON_COLUMNS = new Set(['amenities', 'image_urls', 'raw_payload', 'validation_errors']);
const BOOLEAN_COLUMNS = new Set(['price_on_request', 'requires_review']);

function jsonStringify(value) {
  return JSON.stringify(stableValue(value ?? null));
}

function serializeListing(listing) {
  return Object.fromEntries(LISTING_COLUMNS.map((column) => {
    let value = listing[column];
    if (JSON_COLUMNS.has(column)) value = jsonStringify(value);
    if (BOOLEAN_COLUMNS.has(column)) value = value ? 1 : 0;
    return [column, value ?? null];
  }));
}

function deserializeListing(row) {
  const listing = {};
  for (const column of LISTING_COLUMNS) {
    let value = row[column];
    if (JSON_COLUMNS.has(column)) {
      try {
      value = value === null || value === undefined ? (column === 'raw_payload' ? null : []) : JSON.parse(value);
      } catch {
        value = column === 'raw_payload' ? null : [];
      }
    }
    if (BOOLEAN_COLUMNS.has(column)) value = Boolean(value);
    listing[column] = value;
  }
  return listing;
}

function changedFields(before, after) {
  return LISTING_COLUMNS.filter((column) => {
    if (['first_seen_at', 'last_seen_at', 'scraped_at'].includes(column)) return false;
    return jsonStringify(before[column]) !== jsonStringify(after[column]);
  });
}

class AggregatorStorage {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    if (databasePath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        name TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        status TEXT NOT NULL,
        access_method TEXT NOT NULL,
        status_reason TEXT,
        terms_url TEXT,
        robots_url TEXT,
        last_discovered_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS facebook_groups (
        share_url TEXT PRIMARY KEY,
        canonical_url TEXT,
        status TEXT NOT NULL,
        status_reason TEXT,
        last_checked_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_identity_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_group_url TEXT,
        source_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        source_listing_id TEXT,
        source_post_id TEXT,
        listing_fingerprint TEXT NOT NULL,
        listing_kind TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        property_type TEXT NOT NULL,
        title TEXT,
        description TEXT,
        language TEXT NOT NULL,
        price_raw TEXT,
        price_value REAL,
        currency TEXT,
        price_on_request INTEGER NOT NULL,
        country TEXT,
        region TEXT,
        city TEXT,
        district TEXT,
        address_raw TEXT,
        latitude REAL,
        longitude REAL,
        rooms REAL,
        bedrooms REAL,
        bathrooms REAL,
        area_m2 REAL,
        land_area_m2 REAL,
        floor INTEGER,
        floors_total INTEGER,
        building_type TEXT,
        condition TEXT,
        year_built INTEGER,
        amenities TEXT NOT NULL,
        image_urls TEXT NOT NULL,
        seller_type TEXT NOT NULL,
        seller_display_name TEXT,
        contact_phone TEXT,
        contact_url TEXT,
        published_at TEXT,
        updated_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_text TEXT,
        raw_payload TEXT,
        validation_errors TEXT NOT NULL,
        requires_review INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        missing_runs INTEGER NOT NULL DEFAULT 0,
        last_seen_run_id TEXT,
        created_at TEXT NOT NULL,
        database_updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_listing_id
        ON listings(source, source_listing_id) WHERE source_listing_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_post_id
        ON listings(source, source_post_id) WHERE source_post_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_listings_canonical_url ON listings(source, canonical_url);
      CREATE INDEX IF NOT EXISTS idx_listings_fingerprint ON listings(listing_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(source, status);
      CREATE INDEX IF NOT EXISTS idx_listings_duplicate_candidates
        ON listings(property_type, operation_type, city, district, status);

      CREATE TABLE IF NOT EXISTS listing_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        changed_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,
        UNIQUE(listing_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS crawl_runs (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crawl_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES crawl_runs(run_id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        url TEXT,
        error_type TEXT NOT NULL,
        message TEXT NOT NULL,
        retriable INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        context_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS possible_duplicates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id_a INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        listing_id_b INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        confidence REAL NOT NULL,
        reasons_json TEXT NOT NULL,
        resolution TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(listing_id_a, listing_id_b),
        CHECK(listing_id_a < listing_id_b)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        source TEXT NOT NULL,
        scope TEXT NOT NULL,
        cursor TEXT,
        page_number INTEGER NOT NULL,
        records_seen INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source, scope)
      );
    `);
    /** @type {any} */
    const versionsSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'listing_versions'").get();
    if (versionsSchema?.sql?.includes('UNIQUE(listing_id, content_hash)')) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE listing_versions RENAME TO listing_versions_legacy;
        CREATE TABLE listing_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          changed_fields_json TEXT NOT NULL,
          UNIQUE(listing_id, version_number)
        );
        INSERT INTO listing_versions
          (id, listing_id, version_number, changed_at, content_hash, snapshot_json, changed_fields_json)
        SELECT id, listing_id, version_number, changed_at, content_hash, snapshot_json, changed_fields_json
        FROM listing_versions_legacy;
        DROP TABLE listing_versions_legacy;
        COMMIT;
      `);
    }
  }

  prepare() {
    const placeholders = LISTING_COLUMNS.map((column) => `@${column}`).join(', ');
    const columns = LISTING_COLUMNS.join(', ');
    this.statements = {
      insertListing: this.db.prepare(`
        INSERT INTO listings (
          source_identity_key, ${columns}, content_hash, missing_runs, last_seen_run_id, created_at, database_updated_at
        ) VALUES (
          @source_identity_key, ${placeholders}, @content_hash, 0, @last_seen_run_id, @created_at, @database_updated_at
        )
      `),
      updateListing: this.db.prepare(`
        UPDATE listings SET
          ${LISTING_COLUMNS.map((column) => `${column} = @${column}`).join(', ')},
          source_identity_key = @source_identity_key,
          content_hash = @content_hash,
          missing_runs = 0,
          last_seen_run_id = @last_seen_run_id,
          database_updated_at = @database_updated_at
        WHERE id = @id
      `),
      touchListing: this.db.prepare(`
        UPDATE listings SET last_seen_at = ?, scraped_at = ?, last_seen_run_id = ?, missing_runs = 0,
          database_updated_at = ? WHERE id = ?
      `),
      insertVersion: this.db.prepare(`
        INSERT INTO listing_versions
          (listing_id, version_number, changed_at, content_hash, snapshot_json, changed_fields_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
    };
    this.upsertListingTransaction = this.db.transaction((listing, runId) => this.upsertListingInternal(listing, runId));
  }

  syncConfiguration(config, groups) {
    const now = new Date().toISOString();
    const sourceStatement = this.db.prepare(`
      INSERT INTO sources
        (name, source_type, base_url, status, access_method, status_reason, terms_url, robots_url, last_discovered_at, metadata_json)
      VALUES (@name, @source_type, @base_url, @status, @access_method, @reason, @terms_url, @robots_url, @now, @metadata)
      ON CONFLICT(name) DO UPDATE SET
        source_type = excluded.source_type, base_url = excluded.base_url,
        status = CASE
          WHEN sources.status IN ('blocked', 'temporarily_unavailable')
            AND excluded.status IN ('supported', 'partially_supported') THEN sources.status
          ELSE excluded.status
        END,
        access_method = excluded.access_method,
        status_reason = CASE
          WHEN sources.status IN ('blocked', 'temporarily_unavailable')
            AND excluded.status IN ('supported', 'partially_supported') THEN sources.status_reason
          ELSE excluded.status_reason
        END,
        terms_url = excluded.terms_url, robots_url = excluded.robots_url,
        last_discovered_at = excluded.last_discovered_at, metadata_json = excluded.metadata_json
    `);
    const transaction = this.db.transaction(() => {
      for (const [name, source] of Object.entries(config.sources)) {
        sourceStatement.run({
          name,
          source_type: source.source_type,
          base_url: source.base_url,
          status: source.status,
          access_method: source.access_method,
          reason: source.reason || null,
          terms_url: source.terms_url || null,
          robots_url: source.robots_url || null,
          now,
          metadata: jsonStringify(source),
        });
      }
      const groupStatement = this.db.prepare(`
        INSERT INTO facebook_groups
          (share_url, canonical_url, status, status_reason, last_checked_at, metadata_json)
        VALUES (@share_url, @canonical_url, @status, @reason, @now, @metadata)
        ON CONFLICT(share_url) DO UPDATE SET canonical_url = excluded.canonical_url,
          status = excluded.status, status_reason = excluded.status_reason,
          last_checked_at = excluded.last_checked_at, metadata_json = excluded.metadata_json
      `);
      for (const group of groups) {
        groupStatement.run({ ...group, now, metadata: jsonStringify(group) });
      }
    });
    transaction();
  }

  startRun(source, metadata = {}) {
    const runId = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO crawl_runs (run_id, source, started_at, status, metadata_json)
      VALUES (?, ?, ?, 'running', ?)
    `).run(runId, source, new Date().toISOString(), jsonStringify(metadata));
    return runId;
  }

  finishRun(runId, status, stats = {}) {
    this.db.prepare(`
      UPDATE crawl_runs SET finished_at = ?, status = ?, fetched_count = ?, inserted_count = ?,
        updated_count = ?, unchanged_count = ?, error_count = ?, stop_reason = ?, metadata_json = ?
      WHERE run_id = ?
    `).run(
      new Date().toISOString(), status, stats.fetched ?? 0, stats.inserted ?? 0,
      stats.updated ?? 0, stats.unchanged ?? 0, stats.errors ?? 0,
      stats.stopReason || null, jsonStringify(stats.metadata || {}), runId,
    );
  }

  recordError(runId, source, error, context = {}) {
    this.db.prepare(`
      INSERT INTO crawl_errors (run_id, source, url, error_type, message, retriable, created_at, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId || null,
      source,
      error.url || context.url || null,
      error.name || 'Error',
      String(error.message || error),
      error.retriable ? 1 : 0,
      new Date().toISOString(),
      jsonStringify(context),
    );
  }

  updateSourceStatus(source, status, reason) {
    this.db.prepare(`
      UPDATE sources SET status = ?, status_reason = ?, last_discovered_at = ? WHERE name = ?
    `).run(status, reason || null, new Date().toISOString(), source);
  }

  /** @returns {any} */
  findExisting(listing) {
    const hasStableId = Boolean(listing.source_listing_id || listing.source_post_id);
    if (listing.source_listing_id) {
      const row = this.db.prepare('SELECT * FROM listings WHERE source = ? AND source_listing_id = ?').get(listing.source, listing.source_listing_id);
      if (row) return row;
    }
    if (listing.source_post_id) {
      const row = this.db.prepare('SELECT * FROM listings WHERE source = ? AND source_post_id = ?').get(listing.source, listing.source_post_id);
      if (row) return row;
    }
    const byUrl = this.db.prepare('SELECT * FROM listings WHERE source = ? AND canonical_url = ?').get(listing.source, listing.canonical_url);
    if (byUrl) return byUrl;
    if (hasStableId) return null;
    return this.db.prepare('SELECT * FROM listings WHERE source = ? AND listing_fingerprint = ?').get(listing.source, listing.listing_fingerprint);
  }

  upsertListingInternal(input, runId) {
    const listing = validateListing(input);
    const now = new Date().toISOString();
    const existing = this.findExisting(listing);
    if (!existing) {
      const contentHash = buildContentHash(listing);
      const serialized = serializeListing(listing);
      const result = this.statements.insertListing.run({
        ...serialized,
        source_identity_key: buildSourceIdentity(listing),
        content_hash: contentHash,
        last_seen_run_id: runId,
        created_at: now,
        database_updated_at: now,
      });
      const id = Number(result.lastInsertRowid);
      this.statements.insertVersion.run(id, 1, now, contentHash, jsonStringify(listing), jsonStringify(['created']));
      return { id, action: 'inserted', listing };
    }

    const before = deserializeListing(existing);
    const merged = {
      ...listing,
      first_seen_at: before.first_seen_at,
      last_seen_at: listing.last_seen_at,
      scraped_at: listing.scraped_at,
      status: 'active',
    };
    const contentHash = buildContentHash(merged);
    if (buildContentHash(before) === contentHash) {
      this.statements.touchListing.run(merged.last_seen_at, merged.scraped_at, runId, now, existing.id);
      return { id: existing.id, action: 'unchanged', listing: merged };
    }
    const serialized = serializeListing(merged);
    this.statements.updateListing.run({
      ...serialized,
      id: existing.id,
      source_identity_key: buildSourceIdentity(merged),
      content_hash: contentHash,
      last_seen_run_id: runId,
      database_updated_at: now,
    });
    /** @type {any} */
    const versionRow = this.db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM listing_versions WHERE listing_id = ?').get(existing.id);
    const version = versionRow.value;
    this.statements.insertVersion.run(
      existing.id,
      version,
      now,
      contentHash,
      jsonStringify(merged),
      jsonStringify(changedFields(before, merged)),
    );
    return { id: existing.id, action: 'updated', listing: merged };
  }

  upsertListing(listing, runId) {
    return this.upsertListingTransaction(listing, runId);
  }

  recordCrossSourceDuplicates(listingId) {
    /** @type {any} */
    const currentRow = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!currentRow) return [];
    const current = deserializeListing(currentRow);
    /** @type {any[]} */
    const candidates = this.db.prepare(`
      SELECT * FROM listings
      WHERE source <> @source AND status = 'active' AND property_type = @property_type
        AND (@operation_type = 'unknown' OR operation_type = 'unknown' OR operation_type = @operation_type)
        AND (@city IS NULL OR city IS NULL OR LOWER(city) = LOWER(@city))
        AND (@district IS NULL OR district IS NULL OR LOWER(district) = LOWER(@district))
        AND (@area_m2 IS NULL OR area_m2 IS NULL
          OR ABS(area_m2 - @area_m2) <= MAX(5.0, @area_m2 * 0.15))
        AND (@currency IS NULL OR currency IS NULL OR currency = @currency)
        AND (@price_value IS NULL OR price_value IS NULL OR currency IS NULL OR currency <> @currency
          OR ABS(price_value - @price_value) <= MAX(5000.0, @price_value * 0.20))
      ORDER BY last_seen_at DESC LIMIT 2000
    `).all({
      source: current.source,
      property_type: current.property_type,
      operation_type: current.operation_type,
      city: current.city,
      district: current.district,
      area_m2: current.area_m2,
      currency: current.currency,
      price_value: current.price_value,
    });
    const saved = [];
    const statement = this.db.prepare(`
      INSERT INTO possible_duplicates
        (listing_id_a, listing_id_b, confidence, reasons_json, resolution, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(listing_id_a, listing_id_b) DO UPDATE SET confidence = excluded.confidence,
        reasons_json = excluded.reasons_json, resolution = excluded.resolution, updated_at = excluded.updated_at
    `);
    for (const row of candidates) {
      const comparison = compareListings(current, deserializeListing(row));
      if (comparison.classification === 'distinct') continue;
      const left = Math.min(listingId, row.id);
      const right = Math.max(listingId, row.id);
      const resolution = comparison.classification === 'high_confidence_match' ? 'high_confidence_link' : 'pending_review';
      const now = new Date().toISOString();
      statement.run(left, right, comparison.confidence, jsonStringify(comparison.reasons), resolution, now, now);
      saved.push({ listing_id_a: left, listing_id_b: right, ...comparison, resolution });
    }
    return saved;
  }

  finalizeCompleteSnapshot(source, runId, deletedAfterRuns = 3) {
    /** @type {any[]} */
    const rows = this.db.prepare(`
      SELECT * FROM listings
      WHERE source = ? AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?) AND status <> 'deleted'
    `).all(source, runId);
    const update = this.db.prepare(`
      UPDATE listings SET missing_runs = ?, status = ?, content_hash = ?, database_updated_at = ? WHERE id = ?
    `);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const missingRuns = row.missing_runs + 1;
        const status = missingRuns >= deletedAfterRuns ? 'deleted' : 'inactive';
        const before = deserializeListing(row);
        const after = { ...before, status };
        const contentHash = buildContentHash(after);
        const now = new Date().toISOString();
        update.run(missingRuns, status, contentHash, now, row.id);
        if (before.status !== status) {
          /** @type {any} */
          const versionRow = this.db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM listing_versions WHERE listing_id = ?').get(row.id);
          this.statements.insertVersion.run(
            row.id,
            versionRow.value,
            now,
            contentHash,
            jsonStringify(after),
            jsonStringify(['status']),
          );
        }
      }
    });
    transaction();
  }

  getCheckpoint(source, scope = 'default') {
    /** @type {any} */
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE source = ? AND scope = ?').get(source, scope);
    if (!row) return null;
    return {
      source: row.source,
      scope: row.scope,
      cursor: row.cursor,
      pageNumber: row.page_number,
      recordsSeen: row.records_seen,
      payload: JSON.parse(row.payload_json),
      updatedAt: row.updated_at,
    };
  }

  saveCheckpoint(source, scope, checkpoint) {
    this.db.prepare(`
      INSERT INTO checkpoints (source, scope, cursor, page_number, records_seen, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, scope) DO UPDATE SET cursor = excluded.cursor,
        page_number = excluded.page_number, records_seen = excluded.records_seen,
        payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(
      source,
      scope,
      checkpoint.cursor ?? null,
      checkpoint.pageNumber ?? 0,
      checkpoint.recordsSeen ?? 0,
      jsonStringify(checkpoint.payload || {}),
      new Date().toISOString(),
    );
  }

  clearCheckpoint(source, scope = 'default') {
    this.db.prepare('DELETE FROM checkpoints WHERE source = ? AND scope = ?').run(source, scope);
  }

  getListings(filters = {}, includeInternal = false) {
    const conditions = [];
    const values = [];
    if (filters.source) { conditions.push('source = ?'); values.push(filters.source); }
    if (filters.status) { conditions.push('status = ?'); values.push(filters.status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    /** @type {any[]} */
    const rows = this.db.prepare(`SELECT * FROM listings ${where} ORDER BY first_seen_at DESC, id DESC`).all(...values);
    return rows.map((row) => {
      const listing = deserializeListing(row);
      return includeInternal ? { ...listing, _database_id: row.id, _content_hash: row.content_hash } : listing;
    });
  }

  searchListings(filters = {}) {
    const conditions = [];
    const values = [];
    const addExact = (column, value) => {
      if (value === undefined || value === null || value === '') return;
      conditions.push(`${column} = ?`);
      values.push(value);
    };
    const addMinimum = (column, value) => {
      if (value === undefined || value === null || value === '') return;
      conditions.push(`${column} >= ?`);
      values.push(Number(value));
    };
    const addMaximum = (column, value) => {
      if (value === undefined || value === null || value === '') return;
      conditions.push(`${column} <= ?`);
      values.push(Number(value));
    };

    addExact('source', filters.source);
    addExact('status', filters.status);
    addExact('operation_type', filters.operationType);
    addExact('property_type', filters.propertyType);
    addExact('city', filters.city);
    addExact('district', filters.district);
    addExact('currency', filters.currency);
    addMinimum('price_value', filters.priceMin);
    addMaximum('price_value', filters.priceMax);
    addMinimum('area_m2', filters.areaMin);
    addMaximum('area_m2', filters.areaMax);
    addMinimum('rooms', filters.roomsMin);
    addMaximum('rooms', filters.roomsMax);

    if (filters.query) {
      const escaped = String(filters.query).trim().toLowerCase()
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      if (escaped) {
        conditions.push(`LOWER(
          COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' ||
          COALESCE(raw_text, '') || ' ' || COALESCE(address_raw, '')
        ) LIKE ? ESCAPE '\\'`);
        values.push(`%${escaped}%`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = {
      newest: 'COALESCE(published_at, updated_at, first_seen_at) DESC, id DESC',
      price_asc: 'price_value IS NULL, price_value ASC, id DESC',
      price_desc: 'price_value IS NULL, price_value DESC, id DESC',
      area_desc: 'area_m2 IS NULL, area_m2 DESC, id DESC',
    }[filters.sort || 'newest'];
    if (!orderBy) throw new Error(`Unsupported listing sort: ${filters.sort}`);
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    /** @type {any} */
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM listings ${where}`).get(...values);
    /** @type {any[]} */
    const rows = this.db.prepare(`
      SELECT * FROM listings ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
    return {
      total: totalRow.count,
      count: rows.length,
      limit,
      offset,
      listings: rows.map((row) => ({ ...deserializeListing(row), database_id: row.id })),
    };
  }

  getListingById(databaseId) {
    /** @type {any} */
    const row = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(databaseId));
    return row ? { ...deserializeListing(row), database_id: row.id } : null;
  }

  validateStoredListings() {
    /** @type {any[]} */
    const rows = this.db.prepare('SELECT id, * FROM listings ORDER BY id').all();
    const invalid = [];
    for (const row of rows) {
      const result = safeValidateListing(deserializeListing(row));
      if (!result.success) invalid.push({ id: row.id, issues: result.error.issues });
    }
    return { total: rows.length, valid: rows.length - invalid.length, invalid };
  }

  report() {
    /** @type {any} */
    const versionCount = this.db.prepare('SELECT COUNT(*) AS count FROM listing_versions').get();
    return {
      sources: this.db.prepare('SELECT name, status, access_method, status_reason FROM sources ORDER BY name').all(),
      facebook_groups: this.db.prepare('SELECT status, COUNT(*) AS count FROM facebook_groups GROUP BY status ORDER BY status').all(),
      listings: this.db.prepare('SELECT source, status, COUNT(*) AS count FROM listings GROUP BY source, status ORDER BY source, status').all(),
      versions: versionCount.count,
      possible_duplicates: this.db.prepare('SELECT resolution, COUNT(*) AS count FROM possible_duplicates GROUP BY resolution').all(),
      recent_runs: this.db.prepare('SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT 20').all(),
      recent_errors: this.db.prepare('SELECT source, error_type, message, created_at FROM crawl_errors ORDER BY id DESC LIMIT 20').all(),
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  AggregatorStorage,
  LISTING_COLUMNS,
  changedFields,
  deserializeListing,
  serializeListing,
};
