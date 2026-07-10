'use strict';

class SourceAdapter {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.supportsCompleteSnapshot = Boolean(config.supports_complete_snapshot);
  }

  describe() {
    return {
      name: this.name,
      source_type: this.config.source_type,
      base_url: this.config.base_url,
      status: this.config.status,
      access_method: this.config.access_method,
      reason: this.config.reason,
    };
  }

  /**
   * @param {any} _context
   * @returns {AsyncGenerator<any, void, unknown>}
   */
  async *pages(_context) {
    throw new Error(`Adapter ${this.name} does not implement pages().`);
  }
}

module.exports = { SourceAdapter };
