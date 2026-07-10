'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod/v4');
const { LISTING_STATUSES, OPERATION_TYPES, PROPERTY_TYPES } = require('../constants');
const { AggregatorMcpService } = require('./service');

/** @returns {any} */
function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** @returns {any} */
function failure(error) {
  const payload = {
    error: error instanceof Error ? error.message : String(error),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * @param {(input: any) => any} handler
 * @returns {(input: any) => Promise<any>}
 */
function guarded(handler) {
  return async (input) => {
    try {
      return result(await handler(input));
    } catch (error) {
      return failure(error);
    }
  };
}

function createAggregatorMcpServer(options = {}) {
  const service = options.service || new AggregatorMcpService(options);
  const server = new McpServer(
    { name: 'armenia-realestate', version: '1.1.0' },
    {
      instructions: [
        'Use realestate_sources before crawling to inspect source access status.',
        'A not_permitted or blocked source must remain stopped; MCP does not grant source authorization.',
        'Use realestate_search for bounded catalog queries and realestate_get_listing for one full record.',
      ].join(' '),
    },
  );

  server.registerTool('realestate_sources', {
    title: 'Real-estate source status',
    description: 'List configured Armenian real-estate sources, their access methods, statuses, and stored listing counts.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, guarded(() => service.listSources()));

  server.registerTool('realestate_discovery', {
    title: 'Source discovery report',
    description: 'Return the recorded discovery and access report for websites and configured Facebook groups.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, guarded(() => service.discovery()));

  server.registerTool('realestate_search', {
    title: 'Search property catalog',
    description: 'Search normalized listings already stored in SQLite. Results are bounded and omit raw source payloads.',
    inputSchema: {
      query: z.string().trim().max(200).optional(),
      source: z.string().trim().optional(),
      status: z.enum(LISTING_STATUSES).optional(),
      operation_type: z.enum(OPERATION_TYPES).optional(),
      property_type: z.enum(PROPERTY_TYPES).optional(),
      city: z.string().trim().max(100).optional(),
      district: z.string().trim().max(100).optional(),
      currency: z.enum(['AMD', 'USD', 'EUR', 'RUB']).optional(),
      price_min: z.number().nonnegative().optional(),
      price_max: z.number().nonnegative().optional(),
      area_min: z.number().nonnegative().optional(),
      area_max: z.number().nonnegative().optional(),
      rooms_min: z.number().nonnegative().optional(),
      rooms_max: z.number().nonnegative().optional(),
      sort: z.enum(['newest', 'price_asc', 'price_desc', 'area_desc']).default('newest'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().nonnegative().default(0),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, guarded((input) => service.search({
    query: input.query,
    source: input.source,
    status: input.status,
    operationType: input.operation_type,
    propertyType: input.property_type,
    city: input.city,
    district: input.district,
    currency: input.currency,
    priceMin: input.price_min,
    priceMax: input.price_max,
    areaMin: input.area_min,
    areaMax: input.area_max,
    roomsMin: input.rooms_min,
    roomsMax: input.rooms_max,
    sort: input.sort,
    limit: input.limit,
    offset: input.offset,
  })));

  server.registerTool('realestate_get_listing', {
    title: 'Get one property listing',
    description: 'Return one normalized listing by the database_id provided by realestate_search.',
    inputSchema: { database_id: z.number().int().positive() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, guarded(({ database_id: databaseId }) => {
    const listing = service.getListing(databaseId);
    if (!listing) throw new Error(`Listing ${databaseId} was not found.`);
    return listing;
  }));

  server.registerTool('realestate_crawl', {
    title: 'Run a permitted property crawl',
    description: 'Run one configured adapter with checkpoint support. Policy-gated sources return their access status without fetching pages.',
    inputSchema: {
      source: z.string().trim().min(1),
      resume: z.boolean().default(false),
      dry_run: z.boolean().default(false),
      max_pages: z.number().int().min(1).max(100).optional(),
      max_records: z.number().int().min(1).max(10000).optional(),
      facebook_import_file: z.string().trim().max(255).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, guarded((input) => service.crawl({
    source: input.source,
    resume: input.resume,
    dryRun: input.dry_run,
    maxPages: input.max_pages,
    maxRecords: input.max_records,
    facebookImportFile: input.facebook_import_file,
  })));

  server.registerTool('realestate_report', {
    title: 'Property aggregator report',
    description: 'Return listing, version, duplicate, checkpoint, recent run, and recent error statistics.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, guarded(() => service.report()));

  server.registerTool('realestate_export', {
    title: 'Export property catalog',
    description: 'Export normalized stored listings to JSONL or CSV under the configured export directory.',
    inputSchema: {
      format: z.enum(['jsonl', 'csv']).default('jsonl'),
      source: z.string().trim().optional(),
      split_by_source: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, guarded((input) => service.export({
    format: input.format,
    source: input.source,
    splitBySource: input.split_by_source,
  })));

  return { server, service };
}

async function runStdioServer(options = {}) {
  const { server, service } = createAggregatorMcpServer(options);
  const transport = new StdioServerTransport();
  const close = async () => {
    service.close();
    await server.close();
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  await server.connect(transport);
  console.error('[mcp] Armenia real-estate server is ready on stdio');
  return { server, service, transport };
}

module.exports = {
  createAggregatorMcpServer,
  failure,
  guarded,
  result,
  runStdioServer,
};
