'use strict';

const ARMENIAN_MONTHS = {
  հունվար: 0,
  փետրվար: 1,
  մարտ: 2,
  ապրիլ: 3,
  մայիս: 4,
  հունիս: 5,
  հուլիս: 6,
  օգոստոս: 7,
  սեպտեմբեր: 8,
  հոկտեմբեր: 9,
  նոյեմբեր: 10,
  դեկտեմբեր: 11,
};
const RUSSIAN_MONTHS = {
  январь: 0, января: 0, февраль: 1, февраля: 1, март: 2, марта: 2,
  апрель: 3, апреля: 3, май: 4, мая: 4, июнь: 5, июня: 5,
  июль: 6, июля: 6, август: 7, августа: 7, сентябрь: 8, сентября: 8,
  октябрь: 9, октября: 9, ноябрь: 10, ноября: 10, декабрь: 11, декабря: 11,
};
const ENGLISH_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};

function normalizeSpaces(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return normalizeSpaces(String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'"));
}

function normalizeText(value) {
  return normalizeSpaces(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$€₽֏]+/gu, ' ')
    .trim();
}

function detectLanguage(value) {
  const text = String(value || '');
  const armenian = (text.match(/[\u0531-\u058F]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (armenian >= cyrillic && armenian >= latin && armenian > 0) return 'hy';
  if (cyrillic >= armenian && cyrillic >= latin && cyrillic > 0) return 'ru';
  if (latin > 0) return 'en';
  return 'unknown';
}

function parseNumericToken(value, multiplier = '') {
  let text = String(value || '').trim().replace(/[’']/g, '');
  if (/^\d{1,3}(?:[\s,.]\d{3})+$/.test(text)) {
    text = text.replace(/[\s,.]/g, '');
  } else {
    text = text.replace(/\s/g, '').replace(',', '.');
  }
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return /[kк]/i.test(multiplier) ? number * 1000 : number;
}

function detectCurrency(value) {
  const text = String(value || '');
  if (/\$|\bUSD\b|доллар|դոլար/iu.test(text)) return 'USD';
  if (/֏|\bAMD\b|Դ(?:\s*\/|\s|$)|драм|դրամ/iu.test(text)) return 'AMD';
  if (/€|\bEUR\b|евро|եվրո/iu.test(text)) return 'EUR';
  if (/₽|\bRUB\b|руб(?:\.|л)|ռուբ/iu.test(text)) return 'RUB';
  return null;
}

function parsePrice(value) {
  const raw = normalizeSpaces(value);
  const priceOnRequest = /договорн|по\s+запросу|цена\s+по\s+запросу|negotiable|on\s+request|պայմանագրային|գինը\s+պայմանագր/iu.test(raw);
  const currency = detectCurrency(raw);
  if (priceOnRequest) {
    return { price_raw: raw || null, price_value: null, currency, price_on_request: true };
  }
  const prefix = raw.match(/([$€₽֏])\s*([0-9][0-9\s,.'’]*?)(?:\s*([kк]))?(?=\s|\/|$)/u);
  const suffix = raw.match(/([0-9][0-9\s,.'’]*?)(?:\s*([kк]))?\s*(USD|AMD|EUR|RUB|[$€₽֏]|Դ|доллар(?:ов)?|драм(?:ов)?|евро|руб(?:\.|лей)?)/iu);
  const match = prefix ? [prefix[2], prefix[3]] : suffix ? [suffix[1], suffix[2]] : null;
  const priceValue = match ? parseNumericToken(match[0], match[1]) : null;
  return {
    price_raw: raw || null,
    price_value: priceValue,
    currency,
    price_on_request: false,
  };
}

function parseArea(value) {
  const text = normalizeSpaces(value);
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|м2|м²|sq\.?\s*m(?:eters?)?|sqm|кв\.?\s*м(?:етр(?:а|ов)?)?|ք\.?\s*մ(?:ետր)?|քմ)/iu);
  return match ? parseNumericToken(match[1]) : null;
}

function parseLandArea(value) {
  const text = normalizeSpaces(value);
  const match = text.match(/(?:land|lot|plot|участ(?:ок|ка)|земл[яи]|հող(?:ատարածք)?)\D{0,20}(\d+(?:[.,]\d+)?)\s*(?:m2|m²|м2|м²|sq\.?\s*m|sqm|кв\.?\s*м|ք\.?\s*մ|քմ)/iu);
  return match ? parseNumericToken(match[1]) : null;
}

function parseRooms(value) {
  const text = normalizeSpaces(value);
  const match = text.match(/(\d+(?:[.,]\d+)?)[\s-]*(?:room(?:s)?|комн(?:ат(?:а|ы|ная|ный)?)?|սենյակ)/iu);
  return match ? parseNumericToken(match[1]) : null;
}

function parseFloor(value) {
  const text = normalizeSpaces(value);
  const fraction = text.match(/(?:floor|этаж|հարկ)\s*[:№-]?\s*(-?\d+)\s*\/\s*(\d+)/iu)
    || text.match(/(-?\d+)\s*\/\s*(\d+)\s*(?:floor|этаж|հարկ)/iu);
  if (fraction) return { floor: Number(fraction[1]), floors_total: Number(fraction[2]) };
  const single = text.match(/(?:floor|этаж|հարկ)\s*[:№-]?\s*(-?\d+)/iu);
  return { floor: single ? Number(single[1]) : null, floors_total: null };
}

function toIsoDate(value) {
  const raw = normalizeSpaces(value);
  if (!raw) return null;
  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoDate && !raw.includes('T')) {
    return datePartsToIso(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
  }
  const dotted = raw.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (dotted) {
    return datePartsToIso(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));
  }
  const words = raw.toLowerCase().match(/\b(\d{1,2})\s+([\p{L}.]+)\s+(\d{4})\b/u);
  if (words) {
    const monthName = words[2].replace(/\.$/, '');
    const month = { ...ARMENIAN_MONTHS, ...RUSSIAN_MONTHS, ...ENGLISH_MONTHS }[monthName];
    if (month !== undefined) return datePartsToIso(Number(words[3]), month, Number(words[1]));
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function datePartsToIso(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function detectListingKind(value) {
  const text = normalizeText(value);
  if (/(ищу|куплю|сниму|wanted|looking for|need|փնտրում|կգնեմ|կվարձեմ)/iu.test(text)) return 'wanted';
  if (/(продаю|сдаю|продается|продаётся|сдается|сдаётся|for sale|for rent|վաճառվում|տրվում է վարձով)/iu.test(text)) return 'offer';
  return 'unknown';
}

function detectOperationType(value, hint = 'unknown') {
  const text = normalizeText(value);
  const rentHint = ['long_term_rent', 'short_term_rent', 'daily_rent'].includes(hint);
  if (/(daily|per day|сутк|посуточ|օրավարձ|օրական)/iu.test(text) && (rentHint || hint === 'unknown')) return 'daily_rent';
  if (/(short[ -]?term|краткосроч|կարճաժամկետ)/iu.test(text) && (rentHint || hint === 'unknown')) return 'short_term_rent';
  if (hint !== 'unknown') return hint;
  if (/(exchange|обмен|փոխանակ)/iu.test(text)) return 'exchange';
  const sale = /(for sale|sale|sell|продаж|прода|куплю|buy|վաճառ|կգնեմ)/iu.test(text);
  const rent = /(for rent|rental|rent|аренд|сда[её]|сниму|վարձ|կվարձեմ)/iu.test(text) || /\/\s*(?:month|месяц|ամիս)/iu.test(value);
  if (sale && rent) return 'unknown';
  if (rent) return 'long_term_rent';
  if (sale) return 'sale';
  return hint;
}

function detectPropertyType(value, hint = 'other') {
  const text = normalizeText(value);
  if (/(townhouse|таунхаус|քաղաքային տուն)/iu.test(text)) return 'townhouse';
  if (/(apartment|flat|квартир|բնակարան)/iu.test(text)) return 'apartment';
  if (/(house|villa|дом|коттедж|առանձնատուն|տուն)/iu.test(text)) return 'house';
  if (/(land|plot|lot|земл|участок|հող)/iu.test(text)) return 'land';
  if (/(office|офис|գրասենյակ)/iu.test(text)) return 'office';
  if (/(garage|гараж|ավտոտնակ)/iu.test(text)) return 'garage';
  if (/(room|комнат[ау]|սենյակ)/iu.test(text)) return 'room';
  if (/(commercial|коммерческ|խանութ|առևտրային)/iu.test(text)) return 'commercial';
  return hint;
}

function detectSellerType(value) {
  const text = normalizeText(value);
  if (/(owner|собственник|без посредник|տեր|սեփականատեր)/iu.test(text)) return 'owner';
  if (/(developer|застройщик|կառուցապատող)/iu.test(text)) return 'developer';
  if (/(agency|agent|агент|агентство|риелтор|գործակալ)/iu.test(text)) return 'agency';
  return 'unknown';
}

function inferAmenities(value) {
  const text = normalizeText(value);
  /** @type {Array<[string, RegExp]>} */
  const rules = [
    ['parking', /parking|парков|կայանատեղ/iu],
    ['elevator', /elevator|лифт|վերելակ/iu],
    ['balcony', /balcon|балкон|պատշգամբ/iu],
    ['heating', /heating|отоплен|ջեռուց/iu],
    ['air_conditioning', /air condition|кондиционер|օդորակ/iu],
    ['furnished', /furnished|мебел|կահույք/iu],
    ['internet', /internet|интернет|ինտերնետ/iu],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function inferCondition(value) {
  const text = normalizeText(value);
  if (/newly renovated|fresh renovation|нов(?:ый|ейший) ремонт|նոր վերանորոգ/iu.test(text)) return 'newly_renovated';
  if (/renovated|ремонт|վերանորոգ/iu.test(text)) return 'renovated';
  if (/needs renovation|требует ремонт|без ремонт|վերանորոգման կարիք/iu.test(text)) return 'needs_renovation';
  return null;
}

const CITY_ALIASES = new Map([
  ['yerevan', 'Yerevan'], ['erevan', 'Yerevan'], ['ереван', 'Yerevan'], ['երևան', 'Yerevan'], ['երեւան', 'Yerevan'],
  ['abovyan', 'Abovyan'], ['абовян', 'Abovyan'], ['աբովյան', 'Abovyan'],
]);
const DISTRICT_ALIASES = new Map([
  ['center', 'Kentron'], ['downtown', 'Kentron'], ['kentron', 'Kentron'], ['центр', 'Kentron'], ['կենտրոն', 'Kentron'],
  ['arabkir', 'Arabkir'], ['арабкир', 'Arabkir'], ['արաբկիր', 'Arabkir'],
  ['ajapnyak', 'Ajapnyak'], ['ачапняк', 'Ajapnyak'], ['աջափնյակ', 'Ajapnyak'],
  ['avan', 'Avan'], ['аван', 'Avan'], ['ավան', 'Avan'],
  ['kanaker-zeytun', 'Kanaker-Zeytun'], ['kanaker zeytun', 'Kanaker-Zeytun'], ['канакер зейтун', 'Kanaker-Zeytun'], ['քանաքեռ զեյթուն', 'Kanaker-Zeytun'],
  ['nor nork', 'Nor Nork'], ['нор норк', 'Nor Nork'], ['նոր նորք', 'Nor Nork'],
]);

function normalizePlace(value, aliases) {
  const raw = normalizeSpaces(value);
  return aliases.get(normalizeText(raw)) || raw || null;
}

module.exports = {
  detectCurrency,
  detectLanguage,
  detectListingKind,
  detectOperationType,
  detectPropertyType,
  detectSellerType,
  inferAmenities,
  inferCondition,
  normalizeCity: (value) => normalizePlace(value, CITY_ALIASES),
  normalizeDistrict: (value) => normalizePlace(value, DISTRICT_ALIASES),
  normalizeSpaces,
  normalizeText,
  parseArea,
  parseFloor,
  parseLandArea,
  parseNumericToken,
  parsePrice,
  parseRooms,
  stripHtml,
  toIsoDate,
};
