# Telegram List.am Parents Bot

Бот проверяет новые объявления List.am по квартирам и домам до `$120k`, сохраняет уже виденные `item id` и отправляет новые совпадения всем подписчикам Telegram-бота.

Он не пытается обходить защиту сайта. Если List.am показывает обычную страницу проверки при локальном запуске, запусти с `LISTAM_SHOW_BROWSER=true LISTAM_PAGE_WAIT_SECONDS=180`, пройди проверку в открывшемся окне, затем оставь монитор работать.

## Настройка

1. Создай Telegram-бота через `@BotFather` и получи token.
2. Скопируй `.env.example` в `.env` и заполни `TELEGRAM_BOT_TOKEN`.
3. Запусти бот.
4. Каждый получатель должен написать боту `/start`.
5. Для семейной группы добавь бота в группу и отправь `/start` прямо в группе.

```bash
cp .env.example .env
```

## Команды пользователей

- `/start` - подписаться
- `/stop` - отписаться
- `/latest` - последние найденные варианты
- `/top` - лучшие варианты для родителей
- `/filters` - мои фильтры
- `/budget 100000` - изменить бюджет
- `/score 7` - минимальная оценка для родителей
- `/areas Avan, Nor Nork, Abovyan` - выбрать районы
- `/areas all` - снова все районы
- `/types apartment, house` - типы жилья
- `/reset` - сбросить фильтры
- `/share` - ссылка, чтобы передать бота

## Локальный запуск

Проверить health endpoint:

```bash
DRY_RUN=true SCAN_ON_START=false ./run_telegram_monitor.sh
```

Постоянный запуск:

```bash
./run_telegram_monitor.sh
```

## Render deploy

Рекомендованный вариант - Render Web Service на Docker runtime с persistent disk. `render.yaml` уже добавлен.

Нужно:

1. Залогиниться в Render CLI: `render login`
2. Запушить этот проект в GitHub/GitLab/Bitbucket.
3. Открыть Blueprint в Render Dashboard и заполнить secret `TELEGRAM_BOT_TOKEN`.
4. После деплоя открыть Telegram-бота и отправить `/start`.

Если Render не выставил внешний URL автоматически, добавь env var `PUBLIC_URL=https://your-service.onrender.com`.

## Health

`GET /health` возвращает статус сервиса, подписчиков, последний скан и следующий скан.

## Где хранятся данные локально

- `data/listam-bot-state.json` - уже виденные объявления, подписчики Telegram-бота и offset Telegram updates.
- `data/listam-browser-profile/` - локальный профиль браузера для обычных cookies/session.

В проде Render хранит аналогичные данные на persistent disk `/var/data`.
