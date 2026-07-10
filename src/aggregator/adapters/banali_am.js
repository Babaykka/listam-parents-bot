'use strict';

const { PolicyGatedAdapter } = require('./policy_gated');

class BanaliAmAdapter extends PolicyGatedAdapter {}

module.exports = { BanaliAmAdapter };
