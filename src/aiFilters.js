const { normalizeFilters } = require("./state");
const { normalizeText } = require("./utils");

const FILTER_FIELDS = [
  "price",
  "rooms",
  "area",
  "land",
  "sqm",
  "floor",
  "distance",
  "quality",
  "locations",
  "categories",
  "elevator",
  "condition",
  "keywords",
  "excludeKeywords",
  "all",
];

function filterSchema(config) {
  const locationEnum = config.defaultLocations.length ? config.defaultLocations : ["Yerevan"];
  const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
  const nullableStringArray = { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] };

  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "confidence", "summary", "reply", "patch", "clear"],
    properties: {
      action: { type: "string", enum: ["update", "reset", "unclear", "help", "answer"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string" },
      reply: { type: "string" },
      clear: {
        type: "array",
        items: { type: "string", enum: FILTER_FIELDS },
      },
      patch: {
        type: "object",
        additionalProperties: false,
        required: [
          "minPriceUsd",
          "maxPriceUsd",
          "minRooms",
          "maxRooms",
          "minAreaSqm",
          "maxAreaSqm",
          "minLandSqm",
          "maxLandSqm",
          "maxPricePerSqm",
          "minFloor",
          "maxFloor",
          "maxDistanceMinutes",
          "minQualityScore",
          "locations",
          "categories",
          "elevator",
          "condition",
          "keywords",
          "excludeKeywords",
        ],
        properties: {
          minPriceUsd: nullableNumber,
          maxPriceUsd: nullableNumber,
          minRooms: nullableNumber,
          maxRooms: nullableNumber,
          minAreaSqm: nullableNumber,
          maxAreaSqm: nullableNumber,
          minLandSqm: nullableNumber,
          maxLandSqm: nullableNumber,
          maxPricePerSqm: nullableNumber,
          minFloor: nullableNumber,
          maxFloor: nullableNumber,
          maxDistanceMinutes: nullableNumber,
          minQualityScore: nullableNumber,
          locations: {
            anyOf: [
              { type: "array", items: { type: "string", enum: locationEnum } },
              { type: "null" },
            ],
          },
          categories: {
            anyOf: [
              { type: "array", items: { type: "string", enum: ["apartment", "house"] } },
              { type: "null" },
            ],
          },
          elevator: { type: "string", enum: ["yes", "no", "any", "keep"] },
          condition: { type: "string", enum: ["ready", "needs_work", "any", "keep"] },
          keywords: nullableStringArray,
          excludeKeywords: nullableStringArray,
        },
      },
    },
  };
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function clampNumber(value, min, max) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanList(values) {
  return Array.isArray(values) ? values.map((value) => normalizeText(value)).filter(Boolean).slice(0, 12) : null;
}

function sanitizePatch(config, patch) {
  return {
    minPriceUsd: clampNumber(patch.minPriceUsd, 0, 10000000),
    maxPriceUsd: clampNumber(patch.maxPriceUsd, 10000, 10000000),
    minRooms: clampNumber(patch.minRooms, 1, 20),
    maxRooms: clampNumber(patch.maxRooms, 1, 20),
    minAreaSqm: clampNumber(patch.minAreaSqm, 1, 10000),
    maxAreaSqm: clampNumber(patch.maxAreaSqm, 1, 10000),
    minLandSqm: clampNumber(patch.minLandSqm, 1, 100000),
    maxLandSqm: clampNumber(patch.maxLandSqm, 1, 100000),
    maxPricePerSqm: clampNumber(patch.maxPricePerSqm, 1, 100000),
    minFloor: clampNumber(patch.minFloor, 0, 100),
    maxFloor: clampNumber(patch.maxFloor, 0, 100),
    maxDistanceMinutes: clampNumber(patch.maxDistanceMinutes, 1, 180),
    minQualityScore: patch.minQualityScore === null || patch.minQualityScore === undefined ? null : Math.max(0, Math.min(10, Number(patch.minQualityScore))),
    locations: Array.isArray(patch.locations) ? patch.locations.filter((location) => config.defaultLocations.includes(location)) : null,
    categories: Array.isArray(patch.categories) ? patch.categories.filter((category) => ["apartment", "house"].includes(category)) : null,
    elevator: ["yes", "no", "any"].includes(patch.elevator) ? patch.elevator : "keep",
    condition: ["ready", "needs_work", "any"].includes(patch.condition) ? patch.condition : "keep",
    keywords: cleanList(patch.keywords),
    excludeKeywords: cleanList(patch.excludeKeywords),
  };
}

async function parseFilterRequest(config, currentFilters, userText, context = {}) {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");

  const body = {
    model: config.openaiModel,
    input: [
      {
        role: "developer",
        content: [
          "You are the assistant inside a Telegram bot for List.am real-estate monitoring in Yerevan and nearby places.",
          "You convert natural language real-estate search preferences into a JSON filter patch when the user describes what they want to buy or monitor.",
          "You also answer short questions about yourself, how the bot works, and which commands to use.",
          "Reply only through the provided JSON schema.",
          "Keep unspecified filters unchanged by returning null or keep.",
          "Use reset/all only when the user clearly asks to clear filters.",
          "Budget and prices are USD. Area is square meters. Distance is minutes to Yerevan center.",
          "For houses, land/plot/garden/yard area is square meters and maps to minLandSqm/maxLandSqm.",
          "If the user asks for land, plot, garden, or yard area, set categories to house unless they clearly ask otherwise.",
          "Locations must be chosen exactly from the provided allowed locations.",
          "Interpret 'с ремонтом', 'готовое', 'ready' as condition ready.",
          "Interpret 'под ремонт', 'без ремонта', 'unfinished' as condition needs_work.",
          "Interpret 'без агентств/агентов/agency' as excludeKeywords containing agency and агент.",
          "If the user writes a broad wish, make the best useful patch and summarize it in Russian.",
          "If the user asks how to use the bot, who you are, what you can do, or greets you without search criteria, set action to answer and write a friendly Russian reply in reply.",
          "For answer/help actions, explain that the user can write search preferences in normal text, then confirm with /apply; mention /latest, /filters, /status, /scan, and /tour only when useful.",
          "If the user asks for live status or current listings, do not invent data; tell them to use /status, /latest, /houses, or /apartments.",
          "For unrelated questions, answer briefly that you are focused on List.am real-estate search and can help set filters or explain the bot.",
          "The provided currentFilters may be an unapplied pending filter draft. Treat short follow-up messages like 'add Zovuni', 'also houses', or 'without agencies too' as edits to currentFilters, not as a new search from defaults.",
          "When the user says add/include/also for locations, categories, keywords, or excluded keywords, include the previous values plus the newly requested values in the patch unless they clearly say only/replace.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          allowedLocations: config.defaultLocations,
          allowedCategories: ["apartment", "house"],
          currentFilters: normalizeFilters(config, currentFilters),
          filterContext: {
            source: context.source || "active",
            pendingSummary: normalizeText(context.pendingSummary || ""),
            pendingSourceText: normalizeText(context.pendingSourceText || ""),
          },
          request: userText,
        }),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "real_estate_filter_patch",
        strict: true,
        schema: filterSchema(config),
      },
    },
    reasoning: { effort: "minimal" },
    max_output_tokens: 2000,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API returned ${response.status}`;
    throw new Error(message);
  }
  if (data.status === "incomplete") {
    throw new Error(`OpenAI response was incomplete: ${data.incomplete_details?.reason || "unknown reason"}`);
  }

  const outputText = extractOutputText(data);
  if (!outputText) throw new Error("OpenAI returned an empty response");
  const parsed = JSON.parse(outputText);
  return {
    action: parsed.action,
    confidence: Number(parsed.confidence) || 0,
    summary: normalizeText(parsed.summary),
    reply: normalizeText(parsed.reply),
    clear: Array.isArray(parsed.clear) ? parsed.clear.filter((field) => FILTER_FIELDS.includes(field)) : [],
    patch: sanitizePatch(config, parsed.patch || {}),
  };
}

module.exports = {
  parseFilterRequest,
};
