'use strict';

const { normalizeText } = require('./normalization');

function relativeSimilarity(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  const maximum = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.max(0, 1 - Math.abs(left - right) / maximum);
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(normalizeText(left).split(' ').filter((token) => token.length > 2));
  const rightTokens = new Set(normalizeText(right).split(' ').filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) return null;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : null;
}

function compareListings(left, right) {
  const checks = [];
  const exact = (field, weight, label) => {
    if (left[field] === null || left[field] === undefined || right[field] === null || right[field] === undefined) return;
    checks.push({ weight, score: normalizeText(left[field]) === normalizeText(right[field]) ? 1 : 0, reason: label });
  };
  const numeric = (field, weight, label, minimum) => {
    const score = relativeSimilarity(left[field], right[field]);
    if (score === null) return;
    checks.push({ weight, score: score >= minimum ? score : 0, reason: label });
  };

  exact('operation_type', 0.12, 'same operation');
  exact('property_type', 0.12, 'same property type');
  exact('city', 0.08, 'same city');
  exact('district', 0.08, 'same district');
  numeric('area_m2', 0.15, 'similar area', 0.92);
  numeric('rooms', 0.1, 'same rooms', 0.99);
  numeric('floor', 0.05, 'same floor', 0.99);
  if (left.currency && right.currency && left.currency === right.currency) {
    numeric('price_value', 0.15, 'similar price', 0.9);
  }
  const textScore = tokenSimilarity(
    `${left.title || ''} ${left.description || ''}`,
    `${right.title || ''} ${right.description || ''}`,
  );
  if (textScore !== null) checks.push({ weight: 0.15, score: textScore, reason: 'similar text' });

  const confidence = checks.reduce((sum, check) => sum + check.weight * check.score, 0);
  const positiveReasons = checks.filter((check) => check.score >= 0.8).map((check) => check.reason);
  const rounded = Math.round(confidence * 1000) / 1000;
  let classification = 'distinct';
  if (rounded >= 0.93 && positiveReasons.length >= 5) classification = 'high_confidence_match';
  else if (rounded >= 0.65 && positiveReasons.length >= 3) classification = 'possible_match';
  return { confidence: rounded, reasons: positiveReasons, classification };
}

module.exports = { compareListings, relativeSimilarity, tokenSimilarity };
