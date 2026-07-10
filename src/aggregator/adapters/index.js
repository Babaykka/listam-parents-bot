'use strict';

const { loadFacebookGroups } = require('../config');
const { BanaliAmAdapter } = require('./banali_am');
const { EstateAmAdapter } = require('./estate_am');
const { FacebookGroupsAdapter } = require('./facebook_groups');
const { ListAmAdapter } = require('./list_am');
const { MyRealtyAmAdapter } = require('./myrealty_am');

function createAdapters(config) {
  return new Map([
    ['list_am', new ListAmAdapter('list_am', config.sources.list_am)],
    ['banali_am', new BanaliAmAdapter('banali_am', config.sources.banali_am)],
    ['myrealty_am', new MyRealtyAmAdapter('myrealty_am', config.sources.myrealty_am)],
    ['estate_am', new EstateAmAdapter('estate_am', config.sources.estate_am)],
    ['facebook_groups', new FacebookGroupsAdapter('facebook_groups', config.sources.facebook_groups, loadFacebookGroups(config))],
  ]);
}

module.exports = { createAdapters };
