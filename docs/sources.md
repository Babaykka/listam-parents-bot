# Source adapters

Все адаптеры реализуют интерфейс `SourceAdapter` и выдают страницы вида:

```js
{
  items,
  pageNumber,
  cursor,
  complete,
  sourceUrl,
  fromCache
}
```

Runner валидирует `items`, выполняет idempotent upsert и только после этого сохраняет checkpoint. При лимите внутри страницы checkpoint содержит `itemOffset`, поэтому resume не теряет хвост страницы.

`src/aggregator/browser_transport.js` предоставляет один переиспользуемый Playwright BrowserContext для будущих разрешённых JavaScript-источников. Он проверяет URL до запуска браузера, контролирует redirect domain, останавливается на challenge и хранит optional browser state только локально с правами `0600`. Сейчас ни один live-адаптер не требует браузерный transport.

## Estate.am

`src/aggregator/adapters/estate_am.js`

- транспорт: официальный Atom/RSS;
- четыре ленты в `config/aggregator.json`;
- delay: 10 секунд на домен;
- стабильный ID: суффикс `-d<number>`;
- parser: `fast-xml-parser`, entities выключены;
- complete snapshot: нет;
- detail-page crawling: нет.

## Facebook groups

`src/aggregator/adapters/facebook_groups.js`

- live transport: выключен;
- input: JSONL или CSV;
- allowlist: только 22 настроенные группы;
- post URL: только `facebook.com`, `www.facebook.com`, `m.facebook.com`;
- comments, reactions, members, profiles: не импортируются;
- image-only row: принимается только с явным `is_real_estate: true` и помечается `requires_review`.

JSONL example:

```json
{"group_url":"https://www.facebook.com/share/g/...","post_url":"https://www.facebook.com/groups/.../posts/123/","post_id":"123","text":"Apartment for sale in Yerevan, 70 sqm, 120000 USD","created_at":"2026-07-10T12:00:00+04:00","image_urls":[],"is_real_estate":true}
```

## Policy-gated sources

`list_am`, `banali_am`, `myrealty_am` используют отдельные классы, но наследуются от `PolicyGatedAdapter`. Вызов `crawl` завершается типизированным `AccessPolicyError` до создания HTTP transport request. Причина попадает в `crawl_runs`, `crawl_errors` и `sources`.

После получения письменного разрешения адаптер заменяется реальной реализацией, а политика, разрешённые endpoints, лимиты и дата разрешения фиксируются в конфигурации и документации.
