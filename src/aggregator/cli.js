'use strict';

const path = require('node:path');
const { loadAggregatorConfig, loadFacebookGroups } = require('./config');
const { buildDiscoveryReport } = require('./discovery');
const { exportListings } = require('./exporter');
const { AggregatorRunner } = require('./runner');
const { AggregatorStorage } = require('./storage');

const HELP = `Armenia real-estate aggregator

Usage:
  node scripts/realestate.js discover
  node scripts/realestate.js crawl --source estate_am [--resume] [--max-pages 4]
  node scripts/realestate.js crawl --source facebook_groups --input examples/facebook-import.jsonl
  node scripts/realestate.js crawl --all [--resume] [--dry-run]
  node scripts/realestate.js export --format jsonl|csv [--source estate_am]
  node scripts/realestate.js validate
  node scripts/realestate.js report

Options:
  --config PATH       Config file (default: config/aggregator.json)
  --db PATH           SQLite database override
  --max-pages N       Maximum source pages/feeds per run
  --max-records N     Maximum records per run
  --input PATH        Permitted Facebook JSONL or CSV export
  --output PATH       Export directory override
  --resume            Continue from a saved checkpoint
  --dry-run           Use an in-memory database; no persistent writes
`;

function parseArguments(argv) {
  const command = argv[0] || 'help';
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (['all', 'resume', 'dryRun', 'noSplit'].includes(key)) options[key] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Option ${argument} requires a value.`);
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function print(value, stdout = process.stdout) {
  stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const { command, options } = parseArguments(argv);
  if (command === 'help' || options.help) {
    print(HELP, stdout);
    return 0;
  }
  const config = loadAggregatorConfig(options.config || 'config/aggregator.json');
  if (options.db) config.database_path = path.resolve(options.db);
  const groups = loadFacebookGroups(config);
  const databasePath = options.dryRun ? ':memory:' : config.database_path;
  const storage = new AggregatorStorage(databasePath);
  storage.syncConfiguration(config, groups);

  try {
    if (command === 'discover') {
      print(buildDiscoveryReport(config, groups), stdout);
      return 0;
    }
    if (command === 'crawl') {
      if (!options.all && !options.source) throw new Error('crawl requires --source NAME or --all.');
      const runner = new AggregatorRunner(config, storage);
      const crawlOptions = {
        resume: Boolean(options.resume),
        dryRun: Boolean(options.dryRun),
        maxPages: options.maxPages ? Number(options.maxPages) : undefined,
        maxRecords: options.maxRecords ? Number(options.maxRecords) : undefined,
        inputFile: options.input,
      };
      const result = options.all
        ? await runner.crawlAll(crawlOptions)
        : await runner.crawlSource(options.source, crawlOptions);
      print(result, stdout);
      const results = Array.isArray(result) ? result : [result];
      return results.some((item) => item.error && ['failed', 'blocked'].includes(item.stopReason)) ? 1 : 0;
    }
    if (command === 'export') {
      const files = exportListings(storage, {
        format: options.format || 'jsonl',
        source: options.source || null,
        outputDirectory: options.output || config.export_directory,
        splitBySource: !options.noSplit,
      });
      print({ files }, stdout);
      return 0;
    }
    if (command === 'validate') {
      const result = storage.validateStoredListings();
      print({ ...result, configured_facebook_groups: groups.length }, stdout);
      return result.invalid.length ? 1 : 0;
    }
    if (command === 'report') {
      print(storage.report(), stdout);
      return 0;
    }
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  } finally {
    storage.close();
  }
}

module.exports = { HELP, parseArguments, runCli };
