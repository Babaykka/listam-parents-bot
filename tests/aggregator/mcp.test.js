'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { loadAggregatorConfig, loadFacebookGroups } = require('../../src/aggregator/config');
const { AggregatorStorage } = require('../../src/aggregator/storage');
const { makeListing } = require('./helpers');

const projectRoot = path.resolve(__dirname, '../..');

test('stdio MCP server exposes catalog tools and preserves source policy gates', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'realestate-mcp-'));
  const databasePath = path.join(directory, 'catalog.sqlite');
  const configPath = path.join(projectRoot, 'config/aggregator.json');
  const config = loadAggregatorConfig(configPath);
  const storage = new AggregatorStorage(databasePath);
  storage.syncConfiguration(config, loadFacebookGroups(config));
  const inserted = storage.upsertListing(makeListing(), 'seed-run');
  storage.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'scripts/realestate-mcp.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      AGGREGATOR_CONFIG: configPath,
      AGGREGATOR_DATABASE: databasePath,
      AGGREGATOR_EXPORT_DIR: path.join(directory, 'exports'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'aggregator-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(toolNames.sort(), [
      'realestate_crawl',
      'realestate_discovery',
      'realestate_export',
      'realestate_get_listing',
      'realestate_report',
      'realestate_search',
      'realestate_sources',
    ]);

    const sources = await client.callTool({ name: 'realestate_sources', arguments: {} });
    assert.equal(sources.isError, undefined);
    assert.equal(sources.structuredContent.sources.length, 5);
    assert.equal(sources.structuredContent.facebook_groups.configured, 22);

    const search = await client.callTool({
      name: 'realestate_search',
      arguments: { district: 'Arabkir', price_max: 120000, limit: 5 },
    });
    assert.equal(search.structuredContent.total, 1);
    assert.equal(search.structuredContent.listings[0].database_id, inserted.id);
    assert.equal(Object.hasOwn(search.structuredContent.listings[0], 'raw_payload'), false);

    const detail = await client.callTool({
      name: 'realestate_get_listing',
      arguments: { database_id: inserted.id },
    });
    assert.equal(detail.structuredContent.source_listing_id, '1001');

    const gated = await client.callTool({
      name: 'realestate_crawl',
      arguments: { source: 'list_am', dry_run: true, max_pages: 1, max_records: 10 },
    });
    assert.equal(gated.isError, undefined);
    assert.equal(gated.structuredContent.fetched, 0);
    assert.equal(gated.structuredContent.stopReason, 'not_permitted');

    const report = await client.callTool({ name: 'realestate_report', arguments: {} });
    assert.equal(report.structuredContent.recent_runs.length, 0);
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
