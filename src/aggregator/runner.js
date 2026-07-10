'use strict';

const path = require('node:path');
const { createAdapters } = require('./adapters');
const { AccessPolicyError, SecurityChallengeError } = require('./errors');
const { buildSourceIdentity } = require('./fingerprint');
const { safeValidateListing } = require('./schema');
const { HttpTransport } = require('./transport');

class AggregatorRunner {
  constructor(config, storage, adapters = null) {
    this.config = config;
    this.storage = storage;
    this.adapters = adapters || createAdapters(config);
  }

  transportFor(sourceName, dryRun = false) {
    const source = this.config.sources[sourceName];
    return new HttpTransport({
      allowedDomains: source.allowed_domains,
      timeoutMs: source.timeout_ms ?? this.config.defaults.timeout_ms,
      retries: source.retries ?? this.config.defaults.retries,
      delayMs: source.delay_ms ?? 0,
      cacheDirectory: dryRun ? null : path.join(this.config.cache_directory, sourceName),
      cacheTtlMs: source.cache_ttl_ms ?? this.config.defaults.cache_ttl_ms,
    });
  }

  async crawlSource(sourceName, options = {}) {
    const adapter = this.adapters.get(sourceName);
    if (!adapter) throw new Error(`Unknown source: ${sourceName}`);
    const sourceConfig = this.config.sources[sourceName];
    if (!sourceConfig) throw new Error(`Source ${sourceName} is missing from configuration.`);
    const maxPages = Number(options.maxPages ?? this.config.defaults.max_pages);
    const maxRecords = Number(options.maxRecords ?? this.config.defaults.max_records);
    if (!Number.isInteger(maxPages) || maxPages <= 0) throw new Error('maxPages must be a positive integer.');
    if (!Number.isInteger(maxRecords) || maxRecords <= 0) throw new Error('maxRecords must be a positive integer.');
    const scope = options.inputFile ? `import:${path.resolve(options.inputFile)}` : 'default';
    if (!options.resume) this.storage.clearCheckpoint(sourceName, scope);
    const checkpoint = options.resume ? this.storage.getCheckpoint(sourceName, scope) : null;
    const runId = this.storage.startRun(sourceName, {
      resume: Boolean(options.resume),
      dry_run: Boolean(options.dryRun),
      max_pages: maxPages,
      max_records: maxRecords,
      input_file: options.inputFile ? path.basename(options.inputFile) : null,
    });
    const stats = {
      source: sourceName,
      runId,
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      errors: 0,
      pages: 0,
      duplicates: 0,
      stopReason: null,
    };

    if (checkpoint?.payload?.complete) {
      stats.stopReason = 'checkpoint_already_complete';
      this.storage.clearCheckpoint(sourceName, scope);
      this.storage.finishRun(runId, 'completed', stats);
      return stats;
    }

    let currentCursor = checkpoint?.cursor ?? null;
    let resumeOffset = Number(checkpoint?.payload?.itemOffset || 0);
    let consecutiveNoUnique = 0;
    let exhausted = false;
    const visitedCursors = new Set(currentCursor === null ? [] : [JSON.stringify(currentCursor)]);

    try {
      const context = {
        transport: this.transportFor(sourceName, options.dryRun),
        resumeCursor: currentCursor,
        resumeOffset,
        maxPages,
        maxRecords,
        inputFile: options.inputFile ? path.resolve(options.inputFile) : null,
        now: () => new Date().toISOString(),
      };
      const seenThisRun = new Set();
      const iterator = adapter.pages(context)[Symbol.asyncIterator]();
      while (stats.pages < maxPages) {
        const next = await iterator.next();
        if (next.done) break;
        const page = next.value;
        stats.pages += 1;
        const pageStartCursor = currentCursor;
        const startOffset = resumeOffset;
        resumeOffset = 0;
        let pageUnique = 0;
        let consumed = 0;
        let hitRecordLimit = false;
        const items = page.items || [];

        for (let index = startOffset; index < items.length; index += 1) {
          if (stats.fetched >= maxRecords) {
            hitRecordLimit = true;
            break;
          }
          consumed = index + 1;
          const validation = safeValidateListing(items[index]);
          if (!validation.success) {
            const error = new Error('Listing failed schema validation.');
            error.name = 'ValidationError';
            this.storage.recordError(runId, sourceName, error, {
              url: page.sourceUrl,
              issues: validation.error.issues,
            });
            stats.errors += 1;
            stats.fetched += 1;
            continue;
          }
          const listing = validation.data;
          const identity = buildSourceIdentity(listing);
          if (seenThisRun.has(identity)) continue;
          seenThisRun.add(identity);
          pageUnique += 1;
          stats.fetched += 1;
          const result = this.storage.upsertListing(listing, runId);
          stats[result.action] += 1;
          if (result.action !== 'unchanged') {
            stats.duplicates += this.storage.recordCrossSourceDuplicates(result.id).length;
          }
        }

        if (hitRecordLimit || stats.fetched >= maxRecords) {
          const remainingInPage = consumed < items.length;
          this.storage.saveCheckpoint(sourceName, scope, {
            cursor: remainingInPage ? pageStartCursor : page.cursor,
            pageNumber: page.pageNumber,
            recordsSeen: stats.fetched,
            payload: { itemOffset: remainingInPage ? consumed : 0, complete: false },
          });
          stats.stopReason = 'record_limit';
          break;
        }

        const nextCursorKey = page.cursor === null ? null : JSON.stringify(page.cursor);
        const cursorCycle = nextCursorKey !== null && visitedCursors.has(nextCursorKey);
        if (nextCursorKey !== null) visitedCursors.add(nextCursorKey);
        currentCursor = page.cursor;
        consecutiveNoUnique = pageUnique === 0 ? consecutiveNoUnique + 1 : 0;
        exhausted = Boolean(page.complete || page.cursor === null);
        this.storage.saveCheckpoint(sourceName, scope, {
          cursor: page.cursor,
          pageNumber: page.pageNumber,
          recordsSeen: stats.fetched,
          payload: { itemOffset: 0, complete: exhausted },
        });
        if (consecutiveNoUnique >= 3) {
          stats.stopReason = 'three_pages_without_unique_records';
          break;
        }
        if (cursorCycle) {
          stats.stopReason = 'pagination_cycle';
          break;
        }
        if (exhausted) {
          stats.stopReason = 'source_exhausted';
          break;
        }
      }
      if (!exhausted && iterator.return) await iterator.return();

      if (!stats.stopReason) stats.stopReason = stats.pages >= maxPages ? 'page_limit' : 'source_exhausted';
      if (exhausted) {
        if (adapter.supportsCompleteSnapshot) {
          this.storage.finalizeCompleteSnapshot(
            sourceName,
            runId,
            this.config.defaults.deleted_after_complete_runs,
          );
        }
        this.storage.clearCheckpoint(sourceName, scope);
      }
      this.storage.updateSourceStatus(sourceName, sourceConfig.status, sourceConfig.reason);
      this.storage.finishRun(runId, 'completed', stats);
      return stats;
    } catch (error) {
      stats.errors += 1;
      stats.stopReason = error.status || 'failed';
      this.storage.recordError(runId, sourceName, error, { cursor: currentCursor });
      if (error instanceof SecurityChallengeError) {
        this.storage.updateSourceStatus(sourceName, 'blocked', error.message);
        this.storage.finishRun(runId, 'blocked', stats);
      } else if (error instanceof AccessPolicyError) {
        this.storage.updateSourceStatus(sourceName, error.status, error.message);
        this.storage.finishRun(runId, 'skipped', stats);
      } else {
        this.storage.finishRun(runId, 'failed', stats);
      }
      return { ...stats, error: { name: error.name, message: error.message } };
    }
  }

  async crawlAll(options = {}) {
    const results = [];
    for (const sourceName of this.adapters.keys()) {
      results.push(await this.crawlSource(sourceName, options));
    }
    return results;
  }
}

module.exports = { AggregatorRunner };
