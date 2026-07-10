#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/aggregator/cli');

runCli().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
