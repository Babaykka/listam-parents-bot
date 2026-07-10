'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectLanguage,
  detectListingKind,
  detectOperationType,
  detectPropertyType,
  normalizeCity,
  normalizeDistrict,
  parseArea,
  parseFloor,
  parsePrice,
  parseRooms,
  toIsoDate,
} = require('../../src/aggregator/normalization');

test('normalizes USD, AMD, EUR, and RUB prices without currency conversion', () => {
  assert.deepEqual(parsePrice('$120k'), {
    price_raw: '$120k', price_value: 120000, currency: 'USD', price_on_request: false,
  });
  assert.equal(parsePrice('650,000 Դ/month').currency, 'AMD');
  assert.equal(parsePrice('95 000 EUR').price_value, 95000);
  assert.equal(parsePrice('8 500 000 RUB').currency, 'RUB');
});

test('recognizes negotiable prices in all supported languages', () => {
  assert.equal(parsePrice('цена договорная').price_on_request, true);
  assert.equal(parsePrice('price on request').price_on_request, true);
  assert.equal(parsePrice('գինը պայմանագրային է').price_on_request, true);
});

test('normalizes areas, rooms, and floor fractions', () => {
  assert.equal(parseArea('70 кв. м'), 70);
  assert.equal(parseArea('80 քմ'), 80);
  assert.equal(parseArea('90 м²'), 90);
  assert.equal(parseArea('62.5 sq.m'), 62.5);
  assert.equal(parseRooms('3 комнаты'), 3);
  assert.equal(parseRooms('2-комнатная квартира'), 2);
  assert.equal(parseRooms('4 սենյակ'), 4);
  assert.deepEqual(parseFloor('floor 7/10'), { floor: 7, floors_total: 10 });
});

test('detects Armenian, Russian, and English language', () => {
  assert.equal(detectLanguage('Վաճառվում է բնակարան Երևանում'), 'hy');
  assert.equal(detectLanguage('Продается квартира в Ереване'), 'ru');
  assert.equal(detectLanguage('Apartment for sale in Yerevan'), 'en');
});

test('classifies multilingual real-estate intent and property type', () => {
  assert.equal(detectOperationType('Продается квартира'), 'sale');
  assert.equal(detectOperationType('Երևանում վարձով է տրվում բնակարան'), 'long_term_rent');
  assert.equal(detectOperationType('House for daily rent'), 'daily_rent');
  assert.equal(detectOperationType('Property is offered for sale or rent', 'long_term_rent'), 'long_term_rent');
  assert.equal(detectListingKind('Ищу дом в Ереване'), 'wanted');
  assert.equal(detectPropertyType('Վաճառվում է առանձնատուն'), 'house');
});

test('normalizes common Armenian place aliases', () => {
  assert.equal(normalizeCity('Ереван'), 'Yerevan');
  assert.equal(normalizeCity('Երևան'), 'Yerevan');
  assert.equal(normalizeDistrict('Центр'), 'Kentron');
  assert.equal(normalizeDistrict('Արաբկիր'), 'Arabkir');
});

test('parses ISO, Russian, English, and Armenian dates', () => {
  assert.equal(toIsoDate('10.07.2026'), '2026-07-10T00:00:00.000Z');
  assert.equal(toIsoDate('10 июля 2026'), '2026-07-10T00:00:00.000Z');
  assert.equal(toIsoDate('10 July 2026'), '2026-07-10T00:00:00.000Z');
  assert.equal(toIsoDate('10 հուլիս 2026'), '2026-07-10T00:00:00.000Z');
  assert.equal(toIsoDate('31.02.2026'), null);
});
