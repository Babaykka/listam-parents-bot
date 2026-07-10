// Turns the English blurbs the sources emit into short Russian descriptions.
// It synthesizes from recognizable patterns (agency flag, street, building
// material, features) rather than doing a word-for-word translation, because
// the sources use a small, predictable set of phrasings. Proper nouns (street
// names) stay as-is — transliterating them is out of scope.

const MATERIALS = [
  [/\bstone(?:\s+building)?\b/i, "каменный дом"],
  [/\bpanel(?:s)?(?:\s+building)?\b/i, "панельный дом"],
  [/\bmonolith\w*\b/i, "монолит"],
  [/\b(?:new building|new construction|newly built|new-built)\b/i, "новостройка"],
];

const FEATURES = [
  [/\b(?:newly\s+renovated|renovated|renovation|euro(?:pean)?\s*(?:renovation|standard)?|designer)\b/i, "с ремонтом"],
  [/\b(?:furnished|with\s+furniture)\b/i, "с мебелью"],
  [/\belevator\b/i, "лифт"],
  [/\bcentral\s+heating\b/i, "центральное отопление"],
  [/\b(?:gas|natural gas)\b/i, "газ"],
  [/\bbalcon(?:y|ies)\b/i, "балкон"],
  [/\bgarage\b/i, "гараж"],
  [/\bparking\b/i, "парковка"],
  [/\byard\b/i, "двор"],
];

function detectAgency(text) {
  return /\bagency\b|агентств/i.test(text);
}

function extractStreet(text) {
  const onStreet = text.match(/\bon\s+([A-Za-zА-Яа-яЁё][\w.'-]*(?:\s+[A-Za-zА-Яа-яЁё0-9][\w.'-]*){0,3}?)\s+(street|str\.?|st\.?|avenue|ave\.?|highway|lane|blind\s*alley)\b/i);
  const leadStreet = !onStreet && text.match(/^\s*([A-ZА-Я][\w.'-]*(?:\s+[A-Za-z0-9][\w.'-]*){0,3}?)\s+(st\.?|str\.?|street|avenue|ave\.?)\b/i);
  const m = onStreet || leadStreet;
  if (!m) return "";
  const kind = /aven|ave/i.test(m[2]) ? "просп." : "ул.";
  return `${kind} ${m[1].trim()}`;
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Returns a short Russian description, or "" if nothing meaningful can be built.
function localizeDescription(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (!/[A-Za-z]{3,}/.test(value)) return ""; // already Russian/Armenian — let the normal cleanup handle it

  const parts = [];
  if (detectAgency(value)) parts.push("от агентства");
  const street = extractStreet(value);
  if (street) parts.push(street);
  for (const [re, ru] of MATERIALS) {
    if (re.test(value)) { parts.push(ru); break; }
  }
  const seen = new Set(parts);
  for (const [re, ru] of FEATURES) {
    if (re.test(value) && !seen.has(ru)) { parts.push(ru); seen.add(ru); }
  }

  if (parts.length > 0) return capitalize(parts.join(" · "));
  return "";
}

module.exports = { localizeDescription };
