'use strict';

const { AccessPolicyError } = require('../errors');
const { SourceAdapter } = require('./base');

class PolicyGatedAdapter extends SourceAdapter {
  async *pages() {
    throw new AccessPolicyError(this.config.reason, this.config.status);
  }
}

module.exports = { PolicyGatedAdapter };
