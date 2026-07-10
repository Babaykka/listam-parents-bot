'use strict';

const { PolicyGatedAdapter } = require('./policy_gated');

class ListAmAdapter extends PolicyGatedAdapter {}

module.exports = { ListAmAdapter };
