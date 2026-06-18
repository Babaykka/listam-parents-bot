const { activeSubscribers, deactivateSubscriber, defaultFilters, upsertSubscriber } = require("./state");
const { clamp, escapeHtml, normalizeText } = require("./utils");

function apiUrl(config, method) {
  return `https://api.telegram.org/bot${config.telegramToken}/${method}`;
}

async function telegramApi(config, method, body = {}) {
  if (config.dryRun) {
    console.log(`[dry-run telegram api] ${method} ${JSON.stringify(body)}`);
    if (method === "getUpdates") return [];
    return method === "getMe" ? { username: "dry_run_bot", first_name: "Dry Run Bot" } : true;
  }

  if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const response = await fetch(apiUrl(config, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendMessage(config, chatId, text, options = {}) {
  if (config.dryRun) {
    console.log(`[dry-run telegram -> ${chatId}]\n${text}\n`);
    return true;
  }

  return telegramApi(config, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: options.disablePreview ?? false,
    reply_markup: options.replyMarkup,
  });
}

function listingLine(item) {
  const details = [
    item.location || "локация не распознана",
    item.areaSqm ? `${item.areaSqm} м²` : null,
    item.rooms ? `${item.rooms}к` : null,
    item.floor?.label ? `${item.floor.label} эт.` : null,
    item.pricePerSqm ? `$${item.pricePerSqm}/м²` : null,
    `родит. ${item.parentScore}/10`,
  ].filter(Boolean);

  return [
    `<b>${escapeHtml(item.kind)} · ${escapeHtml(item.priceLabel)}</b>`,
    `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`,
    escapeHtml(details.join(" · ")),
  ].join("\n");
}

function chunkListings(title, listings, config) {
  const chunks = [];
  for (let index = 0; index < listings.length; index += config.telegramBatchSize) {
    const batch = listings.slice(index, index + config.telegramBatchSize);
    chunks.push(`${title} (${batch.length}):\n\n${batch.map(listingLine).join("\n\n")}`);
  }
  return chunks;
}

function subscriberName(subscriber) {
  return subscriber.title || subscriber.username || [subscriber.firstName, subscriber.lastName].filter(Boolean).join(" ") || subscriber.id;
}

function filtersText(config, filters) {
  const categories = filters.categories?.length ? filters.categories.join(", ") : "apartment, house";
  const locations = filters.locations?.length ? filters.locations.join(", ") : "все разрешенные районы";
  return [
    `<b>Твои фильтры</b>`,
    `Бюджет: $${Number(filters.maxPriceUsd || config.maxPriceUsd).toLocaleString("en-US")}`,
    `Мин. оценка для родителей: ${filters.minParentScore ?? config.minParentScore}/10`,
    `Типы: ${escapeHtml(categories)}`,
    `Районы: ${escapeHtml(locations)}`,
  ].join("\n");
}

function matchesSubscriber(config, subscriber, item) {
  const filters = subscriber.filters || defaultFilters(config);
  if (item.priceUsd > (filters.maxPriceUsd || config.maxPriceUsd)) return false;
  if (item.priceUsd < (filters.minPriceUsd || config.minPriceUsd || 0)) return false;
  if (item.parentScore < (filters.minParentScore ?? config.minParentScore)) return false;
  if (filters.categories?.length && !filters.categories.includes(item.kindKey)) return false;
  if (filters.locations?.length && !filters.locations.includes(item.location)) return false;
  return true;
}

function matchingListings(config, subscriber, listings, limit = 10, mode = "latest") {
  const filtered = (listings || []).filter((item) => matchesSubscriber(config, subscriber, item));
  if (mode === "top") {
    filtered.sort((a, b) => b.parentScore - a.parentScore || a.priceUsd - b.priceUsd);
  } else {
    filtered.sort((a, b) => String(b.discoveredAt || b.scannedAt).localeCompare(String(a.discoveredAt || a.scannedAt)));
  }
  return filtered.slice(0, limit);
}

function parseNumberArg(args, fallback) {
  const raw = args.join(" ").replace(/[^\d.]/g, "");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseAreas(config, args) {
  const text = args.join(" ").trim();
  if (!text || /^all|все|reset|сброс$/i.test(text)) return [];

  const lowered = text.toLowerCase();
  const matched = config.defaultLocations.filter((location) => lowered.includes(location.toLowerCase()));
  if (matched.length > 0) return matched;

  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => config.defaultLocations.includes(item));
}

function parseTypes(args) {
  const text = args.join(" ").toLowerCase();
  if (!text || /all|все|reset|сброс/.test(text)) return ["apartment", "house"];
  const types = [];
  if (/apartment|apt|flat|кварт/.test(text)) types.push("apartment");
  if (/house|home|дом|таун/.test(text)) types.push("house");
  return types.length ? types : ["apartment", "house"];
}

function commandKeyboard() {
  return {
    keyboard: [
      [{ text: "/latest" }, { text: "/top" }],
      [{ text: "/filters" }, { text: "/status" }],
      [{ text: "/help" }],
    ],
    resize_keyboard: true,
  };
}

function helpText(config, state) {
  const username = state.bot?.username ? `@${state.bot.username}` : "бота";
  return [
    `<b>List.am Parents Bot</b>`,
    `Я слежу за новыми квартирами/домами до $${config.maxPriceUsd.toLocaleString("en-US")} и отправляю варианты, которые удобны для родителей.`,
    "",
    `<b>Команды</b>`,
    `/start - подписаться`,
    `/stop - отписаться`,
    `/latest - последние найденные варианты`,
    `/top - лучшие по оценке для родителей`,
    `/filters - показать фильтры`,
    `/budget 100000 - изменить бюджет`,
    `/score 7 - минимальная оценка 0-10`,
    `/areas Avan, Nor Nork, Abovyan - районы`,
    `/areas all - снова все районы`,
    `/types apartment, house - типы жилья`,
    `/reset - сбросить фильтры`,
    `/share - ссылка, чтобы передать ${escapeHtml(username)}`,
  ].join("\n");
}

async function configureTelegram(config, state) {
  if (!config.telegramToken && !config.dryRun) return state;

  const bot = await telegramApi(config, "getMe");
  state.bot = {
    id: bot.id,
    username: bot.username,
    firstName: bot.first_name,
  };

  await telegramApi(config, "setMyCommands", {
    commands: [
      { command: "start", description: "Подписаться на новые объявления" },
      { command: "latest", description: "Последние найденные варианты" },
      { command: "top", description: "Лучшие варианты для родителей" },
      { command: "filters", description: "Мои фильтры" },
      { command: "budget", description: "Изменить бюджет" },
      { command: "areas", description: "Выбрать районы" },
      { command: "score", description: "Минимальная оценка" },
      { command: "status", description: "Статус монитора" },
      { command: "help", description: "Помощь" },
      { command: "stop", description: "Отписаться" },
    ],
  });

  if (config.publicUrl) {
    await telegramApi(config, "setWebhook", {
      url: `${config.publicUrl}/telegram/webhook`,
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    console.log(`[telegram] webhook set: ${config.publicUrl}/telegram/webhook`);
  } else if (config.pollTelegramWhenNoWebhook) {
    await telegramApi(config, "deleteWebhook", { drop_pending_updates: false });
    console.log("[telegram] no PUBLIC_URL/RENDER_EXTERNAL_URL, using getUpdates polling");
  }

  return state;
}

async function handleCommand(config, state, message, hooks = {}) {
  const chat = message.chat;
  const from = message.from;
  const text = normalizeText(message.text || "");
  if (!text) return false;

  const parts = text.split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);
  const subscriber = upsertSubscriber(config, state, chat, from);
  subscriber.filters ||= defaultFilters(config);

  if (command === "/start" || command === "/subscribe") {
    await sendMessage(
      config,
      chat.id,
      [
        "Подписка включена.",
        "Я буду присылать новые объявления, которые проходят твои фильтры.",
        "",
        filtersText(config, subscriber.filters),
      ].join("\n"),
      { replyMarkup: commandKeyboard() }
    );
    return true;
  }

  if (command === "/stop" || command === "/unsubscribe") {
    deactivateSubscriber(state, chat.id);
    await sendMessage(config, chat.id, "Подписка выключена. Вернуться можно командой /start.");
    return true;
  }

  if (command === "/help") {
    await sendMessage(config, chat.id, helpText(config, state), { replyMarkup: commandKeyboard(), disablePreview: true });
    return true;
  }

  if (command === "/share") {
    const username = state.bot?.username;
    const link = username ? `https://t.me/${username}` : "Ссылка появится после первого запуска Telegram API.";
    await sendMessage(config, chat.id, `Передать бот можно этой ссылкой:\n${escapeHtml(link)}`, { disablePreview: true });
    return true;
  }

  if (command === "/filters") {
    await sendMessage(config, chat.id, filtersText(config, subscriber.filters));
    return true;
  }

  if (command === "/budget") {
    const budget = clamp(Math.round(parseNumberArg(args, config.maxPriceUsd)), 10000, 10000000);
    subscriber.filters.maxPriceUsd = budget;
    await sendMessage(config, chat.id, `Бюджет обновлен: $${budget.toLocaleString("en-US")}\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/score" || command === "/minscore") {
    const score = clamp(parseNumberArg(args, subscriber.filters.minParentScore ?? config.minParentScore), 0, 10);
    subscriber.filters.minParentScore = Math.round(score * 10) / 10;
    await sendMessage(config, chat.id, `Минимальная оценка обновлена: ${subscriber.filters.minParentScore}/10`);
    return true;
  }

  if (command === "/areas") {
    const areas = parseAreas(config, args);
    subscriber.filters.locations = areas;
    await sendMessage(config, chat.id, areas.length ? `Районы обновлены: ${escapeHtml(areas.join(", "))}` : "Районы сброшены: теперь все разрешенные районы.");
    return true;
  }

  if (command === "/types") {
    const types = parseTypes(args);
    subscriber.filters.categories = types;
    await sendMessage(config, chat.id, `Типы обновлены: ${escapeHtml(types.join(", "))}`);
    return true;
  }

  if (command === "/reset") {
    subscriber.filters = defaultFilters(config);
    await sendMessage(config, chat.id, `Фильтры сброшены.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/latest" || command === "/top") {
    const limit = clamp(Math.round(parseNumberArg(args, 8)), 1, 20);
    const listings = matchingListings(config, subscriber, state.listings || [], limit, command === "/top" ? "top" : "latest");
    if (listings.length === 0) {
      await sendMessage(config, chat.id, "Пока нет сохраненных объявлений под твои фильтры. Подожди следующий скан или расширь фильтры.");
      return true;
    }
    const title = command === "/top" ? "Лучшие варианты" : "Последние подходящие варианты";
    for (const chunk of chunkListings(title, listings, config)) {
      await sendMessage(config, chat.id, chunk);
    }
    return true;
  }

  if (command === "/status") {
    const activeCount = activeSubscribers(state, config).length;
    const lastScan = state.lastScan
      ? `${state.lastScan.at}: найдено ${state.lastScan.scanned}, новых ${state.lastScan.new}, пропущено страниц ${state.lastScan.skipped || 0}`
      : "скана еще не было";
    const nextScan = state.nextScanAt ? state.nextScanAt : "планируется";
    await sendMessage(
      config,
      chat.id,
      [`Монитор работает.`, `Подписчиков: ${activeCount}`, `Последний скан: ${escapeHtml(lastScan)}`, `Следующий скан: ${escapeHtml(nextScan)}`].join("\n")
    );
    return true;
  }

  if (command === "/scan") {
    if (!config.adminChatIds.has(String(chat.id))) {
      await sendMessage(config, chat.id, "Эта команда доступна только администратору.");
      return true;
    }
    await sendMessage(config, chat.id, "Запускаю внеочередной скан.");
    await hooks.scanNow?.();
    return true;
  }

  if (command.startsWith("/")) {
    await sendMessage(config, chat.id, "Не понял команду. Нажми /help.");
    return true;
  }

  return false;
}

async function handleTelegramUpdate(config, state, update, hooks = {}) {
  const message = update.message;
  if (!message?.chat || !message.text) return false;
  return handleCommand(config, state, message, hooks);
}

async function pollTelegramOnce(config, state, hooks = {}) {
  const updates = await telegramApi(config, "getUpdates", {
    offset: Number(state.telegramUpdateOffset || 0) + 1,
    timeout: 0,
    allowed_updates: ["message"],
  });

  for (const update of updates) {
    state.telegramUpdateOffset = Math.max(Number(state.telegramUpdateOffset || 0), update.update_id);
    await handleTelegramUpdate(config, state, update, hooks);
  }
  return updates.length;
}

async function notifySubscribers(config, state, newListings) {
  const recipients = activeSubscribers(state, config);
  if (recipients.length === 0) {
    console.log("[telegram] no subscribers yet");
    return;
  }

  for (const subscriber of recipients) {
    const matches = newListings.filter((item) => matchesSubscriber(config, subscriber, item));
    if (matches.length === 0) continue;
    const title = `Новые объявления для ${escapeHtml(subscriberName(subscriber))}`;
    for (const chunk of chunkListings(title, matches, config)) {
      await sendMessage(config, subscriber.id, chunk);
    }
  }
}

module.exports = {
  configureTelegram,
  handleTelegramUpdate,
  notifySubscribers,
  pollTelegramOnce,
  sendMessage,
};
