'use strict';

const { PolicyGatedAdapter } = require('./policy_gated');

class MyRealtyAmAdapter extends PolicyGatedAdapter {}

module.exports = { MyRealtyAmAdapter };
