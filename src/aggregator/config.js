'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_STATUSES } = require('./constants');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveFrom(root, value) {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(root, value);
}

function loadAggregatorConfig(configPath = process.env.AGGREGATOR_CONFIG || 'config/aggregator.json') {
  const absoluteConfigPath = path.resolve(configPath);
  const projectRoot = path.resolve(path.dirname(absoluteConfigPath), '..');
  const config = readJson(absoluteConfigPath);
  if (!config.sources || typeof config.sources !== 'object') throw new Error('Aggregator config must define sources.');
  for (const [name, source] of Object.entries(config.sources)) {
    if (!SOURCE_STATUSES.includes(source.status)) throw new Error(`Invalid status for ${name}: ${source.status}`);
    if (!Array.isArray(source.allowed_domains) || source.allowed_domains.length === 0) {
      throw new Error(`Source ${name} must define allowed_domains.`);
    }
  }
  return {
    ...config,
    config_path: absoluteConfigPath,
    project_root: projectRoot,
    database_path: resolveFrom(projectRoot, process.env.AGGREGATOR_DATABASE || config.database_path),
    cache_directory: resolveFrom(projectRoot, process.env.AGGREGATOR_CACHE_DIR || config.cache_directory),
    export_directory: resolveFrom(projectRoot, process.env.AGGREGATOR_EXPORT_DIR || config.export_directory),
  };
}

function loadFacebookGroups(config) {
  const relative = config.sources.facebook_groups.groups_config;
  const filePath = resolveFrom(config.project_root, relative);
  const groups = readJson(filePath);
  if (!Array.isArray(groups)) throw new Error('Facebook groups config must be an array.');
  return groups;
}

module.exports = { loadAggregatorConfig, loadFacebookGroups, readJson, resolveFrom };
