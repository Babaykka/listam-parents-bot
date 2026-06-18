const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT_DIR = path.resolve(__dirname, "..", "research");
const AMD_PER_USD = 368.19;

const targets = [
  "Ajapnyak",
  "Arabkir",
  "Avan",
  "Davtashen",
  "Erebuni",
  "Kanaker-Zeytun",
  "Kentron",
  "Malatia-Sebastia",
  "Nor Nork",
  "Nork-Marash",
  "Nubarashen",
  "Shengavit",
  "Abovyan",
  "Arinj",
  "Balahovit",
  "Dzoraghbyur",
  "Jrvezh",
  "Kasakh",
  "Masis",
  "Merdzavan",
  "Parakar",
  "Proshyan",
  "Zovuni",
];

const categoryDefs = [
  { id: 60, type: "apartment", pages: 45 },
  { id: 62, type: "house", pages: 35 },
];

const minutesToCenter = {
  Kentron: 0,
  Arabkir: 10,
  "Kanaker-Zeytun": 15,
  "Nork-Marash": 15,
  Erebuni: 15,
  Shengavit: 15,
  Ajapnyak: 18,
  Davtashen: 18,
  "Nor Nork": 20,
  Avan: 20,
  "Malatia-Sebastia": 22,
  Nubarashen: 30,
  Arinj: 20,
  Jrvezh: 23,
  Zovuni: 24,
  Kasakh: 24,
  Proshyan: 25,
  Parakar: 25,
  Merdzavan: 28,
  Balahovit: 28,
  Dzoraghbyur: 30,
  Masis: 30,
  Abovyan: 30,
};

const badges = [
  "Urgent",
  "Hot offer",
  "Super price",
  "Discount",
  "Agency",
  "Documents verified",
  "Verified with Cadastre",
  "Property Not Verified",
  "Never occupied",
  "Open to negotiation",
  "Listed by Owner",
  "Furnished",
  "Beautiful view",
  "Unprecedented price",
  "Black Friday Sale",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePrice(text) {
  const usd = text.match(/^\$([\d,]+)/);
  if (usd) {
    const amount = Number(usd[1].replace(/,/g, ""));
    return { currency: "USD", amount, usd: amount };
  }
  const amd = text.match(/^([\d,]+)\s*֏/);
  if (amd) {
    const amount = Number(amd[1].replace(/,/g, ""));
    return { currency: "AMD", amount, usd: Math.round(amount / AMD_PER_USD) };
  }
  const eur = text.match(/^€([\d,]+)/);
  if (eur) {
    const amount = Number(eur[1].replace(/,/g, ""));
    return { currency: "EUR", amount, usd: Math.round(amount * 1.1461) };
  }
  return null;
}

function parseArea(text) {
  const area = text.match(/([\d.]+)\s*sq\.m\./);
  return area ? Number(area[1]) : null;
}

function parseLandArea(text) {
  const land = text.match(/on a ([\d,]+)\s*sq\.m\. land/);
  return land ? Number(land[1].replace(/,/g, "")) : null;
}

function parseRooms(text) {
  const rooms = text.match(/(\d+)\s*room/);
  return rooms ? Number(rooms[1]) : null;
}

function parseFloor(text) {
  const floor = text.match(/(\d+)\/(\d+)\s*floor/);
  return floor ? `${floor[1]}/${floor[2]}` : "";
}

function parseLocation(text) {
  for (const target of targets) {
    const re = new RegExp(`\\b${target.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`);
    if (re.test(text)) return target;
  }
  return "";
}

function cleanTitle(text, price) {
  let title = text;
  if (price?.currency === "USD") title = title.replace(/^\$[\d,]+\s*/, "");
  if (price?.currency === "AMD") title = title.replace(/^[\d,]+\s*֏\s*/, "");
  if (price?.currency === "EUR") title = title.replace(/^€[\d,]+\s*/, "");

  for (const badge of badges) {
    title = title.replace(new RegExp(`\\b${badge.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g"), "");
  }
  title = normalizeText(title);
  const loc = parseLocation(title);
  if (loc) {
    const locIndex = title.lastIndexOf(`${loc},`);
    if (locIndex > 20) title = normalizeText(title.slice(0, locIndex));
  }
  return title;
}

function parseItem(raw) {
  const text = normalizeText(raw.text);
  const price = parsePrice(text);
  if (!price || price.usd > 120000) return null;

  const area = parseArea(text);
  const location = parseLocation(text);
  if (!location || !(location in minutesToCenter)) return null;

  const pricePerSqm = area ? Math.round(price.usd / area) : null;
  const id = raw.href.match(/\/item\/(\d+)/)?.[1] || raw.href;

  return {
    id,
    type: raw.type,
    query: raw.query,
    location,
    minutes_to_center: minutesToCenter[location],
    price_usd: price.usd,
    price_original: price.currency === "USD" ? `$${price.amount.toLocaleString("en-US")}` : `${price.amount.toLocaleString("en-US")} ${price.currency}`,
    area_sqm: area,
    land_sqm: parseLandArea(text),
    price_per_sqm_usd: pricePerSqm,
    rooms: parseRooms(text),
    floor: parseFloor(text),
    title: cleanTitle(text, price),
    url: raw.href.split("?")[0],
    source: "List.am",
    raw_text: text,
  };
}

async function waitForListings(page) {
  const markers = [
    "Regular Ads",
    "Top Ads",
    "Ads for",
    "Սովորական հայտարարություններ",
    "Թոփ հայտարարություններ",
    "հայտարարություն",
    "Обычные объявления",
    "Топ объявления",
    "объявлен",
  ];
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await sleep(1200);
    const title = await page.title().catch(() => "");
    const text = await page.locator("body").innerText().catch(() => "");
    if (!/Just a moment/i.test(title) && markers.some((marker) => text.includes(marker))) {
      return true;
    }
  }
  return false;
}

async function extractItems(page, meta) {
  const items = await page.$$eval("a[href*='/item/']", (els) =>
    els
      .map((a) => ({ href: a.href, text: a.innerText.replace(/\s+/g, " ").trim() }))
      .filter((item) => item.text && /(\$|֏|€)/.test(item.text))
  );
  return items.map((item) => ({ ...item, ...meta }));
}

async function scrape() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(path.join(OUT_DIR, "playwright-profile"), {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1440, height: 1200 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  const raw = [];
  for (const category of categoryDefs) {
    for (let pageNo = 1; pageNo <= category.pages; pageNo += 1) {
      const pagePart = pageNo === 1 ? "" : `/${pageNo}`;
      const url = `https://www.list.am/en/category/${category.id}${pagePart}?price2=120000&crc=1`;
      process.stderr.write(`GET ${category.type} p${pageNo}\n`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        const ok = await waitForListings(page);
        if (!ok) {
          process.stderr.write(`  skip: ${await page.title().catch(() => "no title")}\n`);
          continue;
        }
        const items = await extractItems(page, { type: category.type, query: "" });
        process.stderr.write(`  items: ${items.length}\n`);
        raw.push(...items);
        if (items.length === 0) break;
      } catch (error) {
        process.stderr.write(`  error: ${error.message}\n`);
      }
    }
  }

  await context.close();

  const seen = new Set();
  const parsed = [];
  for (const item of raw) {
    const parsedItem = parseItem(item);
    if (!parsedItem || seen.has(parsedItem.id)) continue;
    seen.add(parsedItem.id);
    parsed.push(parsedItem);
  }

  parsed.sort((a, b) => {
    const aP = a.price_per_sqm_usd ?? 999999;
    const bP = b.price_per_sqm_usd ?? 999999;
    if (aP !== bP) return aP - bP;
    return a.price_usd - b.price_usd;
  });

  fs.writeFileSync(path.join(OUT_DIR, "listam_raw.json"), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "listam_candidates.json"), JSON.stringify(parsed, null, 2));
  console.log(JSON.stringify({ raw: raw.length, candidates: parsed.length }, null, 2));
}

scrape().catch((error) => {
  console.error(error);
  process.exit(1);
});
