const assert = require("assert/strict");
const { performance } = require("perf_hooks");
const { handleTelegramUpdate, notifySubscribers } = require("../src/telegram");
const { defaultFilters, readState, writeState } = require("../src/state");
const { createFakeTelegram, listing, telegramError, testConfig, update } = require("./test_helpers");

function makeSubscriber(config, id, index) {
  const filters = defaultFilters(config);
  filters.maxPriceUsd = index % 3 === 0 ? 100000 : 120000;
  filters.categories = index % 2 === 0 ? ["apartment"] : ["house"];
  filters.locations = index % 2 === 0 ? ["Avan", "Nor Nork"] : ["Abovyan", "Jrvezh"];
  filters.minQualityScore = index % 5 === 0 ? 6 : 0;
  filters.maxDistanceMinutes = 30;
  return {
    id: String(id),
    type: "private",
    username: `stress_${id}`,
    firstName: `Stress${id}`,
    lastName: "",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filters,
  };
}

function makeListings(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const house = index % 2 === 1;
    const location = house ? (index % 4 === 1 ? "Abovyan" : "Jrvezh") : index % 4 === 0 ? "Avan" : "Nor Nork";
    rows.push(
      listing(500000 + index, {
        kindKey: house ? "house" : "apartment",
        location,
        priceUsd: 70000 + (index % 7) * 7000,
        rooms: house ? 4 : 2 + (index % 2),
        landSqm: house ? 220 + index : null,
        floor: house ? null : { current: 2 + (index % 3), total: 12, label: `${2 + (index % 3)}/12` },
        qualityScore: 5 + (index % 6),
      })
    );
  }
  return rows;
}

async function main() {
  const fake = createFakeTelegram();
  const blockedIds = new Set(["1097", "1194", "1291", "1388", "1485"]);
  fake.failSend = (body) => (blockedIds.has(String(body.chat_id)) ? telegramError(403, "Forbidden: bot was blocked by the user", 403) : null);

  const config = testConfig({
    telegramApi: fake.api,
    telegramBatchSize: 6,
    telegramSendDelayMs: 0,
    maxListingsCache: 1000,
  });
  const state = readState(config);
  state.subscribers = Array.from({ length: 500 }, (_, index) => makeSubscriber(config, 1000 + index, index));
  writeState(config, state);

  const listings = makeListings(180);
  const started = performance.now();
  await notifySubscribers(config, state, listings);
  const notifyMs = Math.round(performance.now() - started);

  assert(fake.sendAttempts > 0);
  assert(fake.messages.length > 0);
  assert(notifyMs < 8000, `notifySubscribers was too slow: ${notifyMs}ms`);
  for (const id of blockedIds) {
    assert.equal(state.subscribers.find((subscriber) => subscriber.id === id).active, false, `blocked subscriber ${id} should be inactive`);
  }
  assert.equal(state.subscribers.find((subscriber) => subscriber.id === "1001").active, true);

  const uniqueMessageKeys = new Set(fake.messages.map((message) => `${message.chat_id}:${message.text}`));
  assert.equal(uniqueMessageKeys.size, fake.messages.length);

  const statusStarted = performance.now();
  for (let index = 0; index < 250; index += 1) {
    await handleTelegramUpdate(config, state, update("/status", 200000 + index));
  }
  const statusMs = Math.round(performance.now() - statusStarted);
  assert(statusMs < 5000, `status command stress was too slow: ${statusMs}ms`);
  assert(state.subscribers.length >= 750);

  console.log(
    "stress bot test passed",
    JSON.stringify({
      subscribers: state.subscribers.length,
      listings: listings.length,
      sentMessages: fake.messages.length,
      sendAttempts: fake.sendAttempts,
      notifyMs,
      statusMs,
    })
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
