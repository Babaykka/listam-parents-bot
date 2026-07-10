const { clamp, normalizeText } = require("./utils");

// Parses a free-text real-estate post that a user forwards/pastes into the bot
// (e.g. from a Facebook group they belong to). This is user-supplied content the
// person already has access to — not scraping. Best-effort heuristic parsing.

const PROPERTY_WORDS = /(кварт|apartment|flat|բնակարան|дом|house|villa|таунхаус|townhouse|առանձնատուն|коттедж|студи|studio)/i;
const PRICE_MARKER = /(\$|USD|дол|долл|драм|֏|AMD|\bamd\b|\bk\b|тыс|млн)/i;

function looksLikeListingPost(text) {
  const value = normalizeText(text);
  if (value.length < 40) return false; // filter requests are short imperatives
  if (!PROPERTY_WORDS.test(value)) return false;
  if (!PRICE_MARKER.test(value) && !/\d{4,}/.test(value)) return false;
  // Must read like a description, not a command to the bot.
  if (/^(добав|покажи|найди|хочу|ищу|фильтр|настрой)/i.test(value) && value.length < 90) return false;
  return true;
}

function parsePrice(text, config) {
  const value = String(text || "");
  const usd = value.match(/\$\s*([\d][\d\s.,]*)|([\d][\d\s.,]*)\s*(?:\$|usd|дол(?:л(?:ар)?)?)/i);
  if (usd) {
    const raw = usd[1] || usd[2];
    const amount = compactThousands(raw, value);
    if (amount) return { priceUsd: Math.round(amount), priceLabel: `$${Math.round(amount).toLocaleString("en-US")}` };
  }
  const amd = value.match(/([\d][\d\s.,]*)\s*(?:драм|֏|amd|dram)/i);
  if (amd) {
    const amount = compactThousands(amd[1], value);
    const rate = Number(config.amdPerUsd || 390);
    if (amount && rate > 0) {
      const priceUsd = Math.round(amount / rate);
      return { priceUsd, priceLabel: `${Math.round(amount).toLocaleString("en-US")} AMD (~$${priceUsd.toLocaleString("en-US")})` };
    }
  }
  // Bare "120k" / "120 000" near a property word.
  const k = value.match(/\b(\d{2,3})\s*(?:k|к|тыс)\b/i);
  if (k) {
    const amount = Number(k[1]) * 1000;
    return { priceUsd: amount, priceLabel: `$${amount.toLocaleString("en-US")}` };
  }
  return null;
}

function compactThousands(raw, fullText) {
  const digits = String(raw || "").replace(/[\s.,]/g, "");
  let amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // "120k" style already handled; treat small numbers followed by k as thousands.
  if (amount < 1000 && /\bk\b|тыс|к\b/i.test(fullText)) amount *= 1000;
  return amount;
}

function parseArea(text) {
  const match = String(text || "").match(/(\d{2,4})\s*(?:кв\.?\s*м|квм|м²|м2|m²|m2|sq\.?\s*m|sqm)/i);
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) && value >= 10 && value <= 100000 ? value : null;
}

function parseRooms(text) {
  const match = String(text || "").match(/(\d)\s*(?:комнат|комн|room|rooms|սենյak|-к\b|-комн)/i);
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) && value >= 1 && value <= 20 ? value : null;
}

function parseFloor(text) {
  const match = String(text || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:этаж|эт\.?|floor)?/i) || String(text || "").match(/(?:этаж|floor)\s*(\d{1,2})\s*\/\s*(\d{1,2})/i);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total > 60) return null;
  return { current, total, label: `${current}/${total}` };
}

function parseKind(text) {
  if (/(дом|house|villa|таунхаус|townhouse|առանձնատուն|коттедж)/i.test(text)) return "house";
  return "apartment";
}

function escapedRegex(value) {
  return String(value || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Russian / Armenian spellings of Yerevan districts and nearby towns → the
// canonical Latin names used in config. Forwarded posts are usually in Russian.
const LOCATION_ALIASES = [
  [/аван|ավան/i, "Avan"],
  [/арабкир|արաբկիր/i, "Arabkir"],
  [/ачапняк|аджапняк|աջափնյակ/i, "Ajapnyak"],
  [/давташен|դավթաշեն/i, "Davtashen"],
  [/эребуни|էրեբունի/i, "Erebuni"],
  [/канакер[\s-]*зейтун|քանաքեռ/i, "Kanaker-Zeytun"],
  [/норк[\s-]*мараш/i, "Nork-Marash"],
  [/нор[\s-]*норк|նոր[\s-]*նորք/i, "Nor Nork"],
  [/нубарашен/i, "Nubarashen"],
  [/малатия[\s-]*себастия|малатия|մալաթիա/i, "Malatia-Sebastia"],
  [/шенгавит|շենգավիթ/i, "Shengavit"],
  [/кентрон|центр(?:е|альн)?|կենտրոն/i, "Kentron"],
  [/абовян|աբովյան/i, "Abovyan"],
  [/зовуни|զովունի/i, "Zovuni"],
  [/паракар|առաքար|파rakar/i, "Parakar"],
  [/прошян|պռոշյան/i, "Proshyan"],
  [/джрвеж|ջրվեժ/i, "Jrvezh"],
  [/аринж|արինջ/i, "Arinj"],
  [/масис|մասիս/i, "Masis"],
  [/птгни|պտղնի/i, "Ptghni"],
  [/дзорагхбюр|дзорахбюр/i, "Dzoraghbyur"],
];

function parseLocation(text, config) {
  const value = normalizeText(text);
  for (const location of config.defaultLocations) {
    if (new RegExp(`\\b${escapedRegex(location)}\\b`, "i").test(value)) return location;
  }
  for (const [pattern, location] of LOCATION_ALIASES) {
    if (pattern.test(value) && config.defaultLocations.includes(location)) return location;
  }
  return "";
}

function parseCondition(text) {
  const lower = String(text || "").toLowerCase();
  if (/капремонт|евроремонт|newly renovated|renovated|с ремонтом|дизайнерск/i.test(lower)) return "ready";
  if (/без ремонта|под ремонт|нужен ремонт|needs renovation|черновая/i.test(lower)) return "needs_work";
  return "unknown";
}

function parseContactPhone(text) {
  const matches = String(text || "").match(/\+?\d[\d\s()\-.]{6,}\d/g) || [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) {
      // Normalize Armenian numbers to +374 XX XXXXXX where possible.
      if (digits.startsWith("374") && digits.length === 11) return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}`;
      if (digits.startsWith("0") && digits.length === 9) return `+374 ${digits.slice(1, 3)} ${digits.slice(3)}`;
      return raw.trim().replace(/\s+/g, " ");
    }
  }
  return null;
}

const NAME_LABEL = /(?:контактное лицо|контакт|звоните|звонить|обращаться|имя|owner|contact|name|անուն)\s*[:\-]?\s*/i;
// Name pattern kept case-sensitive (must start uppercase) even though the label above is not.
const NAME_VALUE = /^([A-ZА-ЯЁԱ-Ֆ][A-Za-zА-Яа-яЁёԱ-Ֆա-ֆ]{1,20}(?:\s+[A-ZА-ЯЁԱ-Ֆ][A-Za-zА-Яа-яЁёԱ-Ֆա-ֆ]{1,20})?)/;

function parseContactName(text) {
  const value = normalizeText(text);
  const label = value.match(NAME_LABEL);
  if (!label) return "";
  const nameMatch = value.slice(label.index + label[0].length).match(NAME_VALUE);
  const name = nameMatch ? normalizeText(nameMatch[1]) : "";
  // Guard against picking up common non-name words.
  if (!name || /^(агент|owner|contact|name|звони|call)$/i.test(name)) return "";
  return name.slice(0, 40);
}

function stableId(text, meta) {
  const seed = `${meta?.fromId || ""}:${meta?.messageId || ""}:${normalizeText(text).slice(0, 80)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `fwd:${hash.toString(36)}`;
}

function parseForwardedListing(text, config, meta = {}) {
  const value = normalizeText(text);
  const price = parsePrice(value, config);
  if (!price) return null;
  if (price.priceUsd > Number(config.maxPriceUsd || 120000) * 3) return null; // guard against phone numbers read as price

  const kindKey = parseKind(value);
  const location = parseLocation(value, config);
  const areaSqm = parseArea(value);
  const rooms = parseRooms(value);
  const floor = kindKey === "apartment" ? parseFloor(value) : null;
  const condition = parseCondition(value);
  const contactPhone = parseContactPhone(value);
  // Prefer a name from the Telegram forward header; fall back to a labelled name in the text.
  const contactName = normalizeText(meta.contactName || "").slice(0, 40) || parseContactName(value);

  const item = {
    id: stableId(value, meta),
    source: "facebook",
    sourceLabel: "Facebook",
    kind: kindKey === "house" ? "Дом" : "Квартира",
    kindKey,
    title: value.slice(0, 120),
    url: meta.url || "",
    imageUrl: meta.imageUrl || null,
    priceLabel: price.priceLabel,
    priceUsd: price.priceUsd,
    areaSqm,
    pricePerSqm: areaSqm ? Math.round(price.priceUsd / areaSqm) : null,
    rooms,
    floor,
    landSqm: null,
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator: null,
    condition,
    publishedAt: null,
    publishedAtPrecision: null,
    updatedAt: null,
    updatedAtPrecision: null,
    rawText: value.slice(0, 1200),
    scannedAt: new Date().toISOString(),
    qualityScore: clamp(5 + (condition === "ready" ? 1 : 0) + (areaSqm >= 70 ? 0.5 : 0), 0, 10),
    forwardedBy: meta.fromId ? String(meta.fromId) : null,
    contactName: contactName || null,
    contactPhone: contactPhone || null,
  };
  return item;
}

module.exports = {
  looksLikeListingPost,
  parseForwardedListing,
  __test: { parsePrice, parseArea, parseRooms, parseFloor, parseLocation, parseContactPhone, parseContactName },
};
