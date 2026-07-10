#!/usr/bin/env node
'use strict';

const { runStdioServer } = require('../src/aggregator/mcp/server');

runStdioServer().catch((error) => {
  console.error(`[mcp] ${error.stack || error.message}`);
  process.exitCode = 1;
});
