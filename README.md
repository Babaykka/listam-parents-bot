# Агрегатор недвижимости Армении

В репозитории теперь два независимых продукта:

- существующий Telegram-бот запускается командой `npm start`;
- отдельный агрегатор собирает разрешённые данные, нормализует объявления, хранит историю и экспортирует SQLite/JSONL/CSV.
- локальный MCP-сервер даёт Claude Code/Desktop инструменты поиска, crawl, отчёта и экспорта поверх того же ядра.

Агрегатор не обходит CAPTCHA, WAF, авторизацию или ограничения площадок. Если условия источника запрещают автоматический сбор, адаптер останавливается до сетевого запроса и фиксирует причину.

## Статус источников

| Источник | Статус | Способ |
| --- | --- | --- |
| Estate.am | `partially_supported` | официальные Atom/RSS-ленты продажи и аренды квартир/домов |
| Facebook-группы | `partially_supported` | импорт разрешённого JSONL/CSV; live-сбор выключен |
| List.am | `not_permitted` | автоматический доступ отключён условиями площадки |
| Banali.am | `not_permitted` | требуется письменное разрешение на копирование/хранение |
| MyRealty.am | `not_permitted` | автоматический доступ отключён условиями площадки |

Подробности и проверенные ссылки находятся в [docs/discovery.md](docs/discovery.md) и [docs/legal-and-access-limitations.md](docs/legal-and-access-limitations.md).

## Быстрый запуск

Требуется Node.js 20 или новее.

```bash
npm ci
node scripts/realestate.js discover
node scripts/realestate.js crawl --source estate_am --max-pages 1 --max-records 20
node scripts/realestate.js report
node scripts/realestate.js export --format jsonl
node scripts/realestate.js export --format csv
```

MCP-сервер:

```bash
npm run mcp
```

Для Claude Code уже добавлен проектный [.mcp.json](.mcp.json). Инструменты и настройка Claude Desktop описаны в [docs/mcp.md](docs/mcp.md).

Полный разрешённый запуск:

```bash
node scripts/realestate.js crawl --all --resume
```

Источники с запретом будут отмечены как пропущенные; запросы к ним не отправляются. Estate соблюдает `Crawl-delay: 10`, поэтому полный проход четырёх RSS-лент занимает не меньше 30 секунд без учёта сети.

## Команды

```text
discover
crawl --source list_am
crawl --source banali_am
crawl --source myrealty_am
crawl --source estate_am
crawl --source facebook_groups --input export.jsonl
crawl --all
crawl --all --resume
crawl --all --max-pages 5 --max-records 500
export --format jsonl
export --format csv
validate
report
```

Для проверки без постоянной базы добавьте `--dry-run`. Кэш в этом режиме также не записывается.

## Facebook-импорт

Все 22 группы находятся в `config/facebook-groups.json`. Автоматическое открытие share-ссылок и вход в Facebook выключены, потому что Meta требует отдельного письменного разрешения для automated data collection.

Разрешённый экспорт можно передать в JSONL или CSV:

```bash
node scripts/realestate.js crawl \
  --source facebook_groups \
  --input examples/facebook-import.jsonl
```

Поддерживаемые входные поля: `group_url`, `post_url`, `post_id`, `text`, `created_at`, `image_urls`, `is_real_estate`. Поля `group_url` и `post_url` обязательны. Группа должна присутствовать в конфигурации. Телефоны и email в Facebook-тексте редактируются; произвольные поля входного файла не сохраняются.

## Данные

- SQLite: `data/realestate.sqlite`;
- HTTP-кэш: `data/aggregator-cache/`;
- объединённый экспорт: `exports/listings-all.jsonl` или `.csv`;
- экспорт по источникам: `exports/listings-<source>.<format>`;
- пример записи: `examples/expected-listing.jsonl`.

Повторный запуск идемпотентен. Изменение объявления создаёт запись в `listing_versions`; старое состояние не перезаписывается. Удаление определяется только для источника, который дал полный успешный снимок. Короткая RSS-лента Estate не считается полным снимком.

## Проверка качества

```bash
npm run verify:aggregator
npm test
```

`verify:aggregator` запускает ESLint, проверку типов и unit-тесты. Полный `npm test` дополнительно прогоняет существующие full/stress тесты Telegram-бота.

Последний ограниченный smoke-test: 4 официальные RSS-ленты Estate, 81 уникальный ID, 81/81 валидных записей, 0 сетевых/парсерных ошибок. Повторный проход: 0 новых, 0 изменённых, 81 без изменений.

## Архитектура

```text
config/                         источники и 22 Facebook-группы
src/aggregator/adapters/        изолированные правила площадок
src/aggregator/transport.js     allowlist, delay, retry, cache, challenge stop
src/aggregator/storage.js       SQLite, версии, checkpoints, дубликаты
src/aggregator/runner.js        ограниченный и возобновляемый обход
src/aggregator/normalization.js нормализация hy/ru/en и валют
src/aggregator/exporter.js      JSONL и CSV
src/aggregator/mcp/             официальный MCP SDK, tools и безопасный service layer
scripts/realestate.js           CLI
scripts/realestate-mcp.js       MCP stdio entrypoint
```

Инструкция по расширению: [docs/adding-source.md](docs/adding-source.md). Полная схема: [docs/data-schema.md](docs/data-schema.md).
