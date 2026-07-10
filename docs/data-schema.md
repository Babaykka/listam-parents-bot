# Data schema

Нормализованная запись валидируется строгой Zod-схемой `src/aggregator/schema.js`. Неизвестные и неоднозначные значения сохраняются как `null`; исходный разрешённый текст остаётся в `raw_text`, структурированный фрагмент источника — в `raw_payload`. В Facebook-импорте контакты редактируются, а `raw_payload` собирается по белому списку полей.

## Identity and provenance

| Поле | Назначение |
| --- | --- |
| `source`, `source_type` | адаптер и тип источника |
| `source_group_url` | настроенная Facebook-группа либо `null` |
| `source_url`, `canonical_url` | исходный и очищенный URL |
| `source_listing_id`, `source_post_id` | стабильный ID площадки |
| `listing_fingerprint` | SHA-256 нормализованных характеристик |
| `parser_version` | версия правил извлечения |

Внутри источника приоритет идентификации: стабильный ID, canonical URL, fingerprint. Если два разных стабильных ID похожи, они не объединяются fingerprint-ом.

## Classification

- `listing_kind`: `offer`, `wanted`, `unknown`;
- `operation_type`: `sale`, `long_term_rent`, `short_term_rent`, `daily_rent`, `exchange`, `unknown`;
- `property_type`: `apartment`, `house`, `townhouse`, `land`, `commercial`, `office`, `garage`, `room`, `other`;
- `seller_type`: `owner`, `agency`, `developer`, `unknown`;
- `status`: `active`, `inactive`, `deleted`, `unknown`.

## Content and price

`title`, `description`, `language`, `price_raw`, `price_value`, `currency`, `price_on_request`.

Поддерживаемые валюты: AMD, USD, EUR, RUB. Валюта не пересчитывается. Исходное представление всегда сохраняется в `price_raw`.

## Location and property

`country`, `region`, `city`, `district`, `address_raw`, `latitude`, `longitude`, `rooms`, `bedrooms`, `bathrooms`, `area_m2`, `land_area_m2`, `floor`, `floors_total`, `building_type`, `condition`, `year_built`, `amenities`, `image_urls`.

Неполный район не превращается в точный адрес или координаты. `image_urls` содержит только опубликованные URL; агрегатор не загружает изображения Estate для perceptual hashing.

## Seller and contact

`seller_display_name`, `contact_phone`, `contact_url`.

Для Facebook по умолчанию сохраняется URL публикации. Телефоны из свободного текста не извлекаются. Название продавца импортируется только при явном `seller_is_business: true`.

## Dates

| Поле | Семантика |
| --- | --- |
| `published_at` | дата публикации, только если источник её явно дал |
| `updated_at` | дата обновления источника |
| `first_seen_at` | когда агрегатор впервые увидел запись |
| `last_seen_at` | последний успешный проход с этой записью |
| `scraped_at` | время текущего извлечения |

`first_seen_at` никогда не выдаётся за дату публикации. У Estate Atom есть `<updated>`, но нет надёжного `<published>`, поэтому `published_at` равен `null`.

## Validation and review

`validation_errors` хранит неоднозначности, а `requires_review` помечает запись для ручной проверки. Отсутствующее значение не придумывается для прохождения схемы.

## SQLite tables

| Таблица | Содержимое |
| --- | --- |
| `sources` | статус и политика доступа каждого адаптера |
| `facebook_groups` | 22 share URL, canonical URL и статус |
| `listings` | текущее нормализованное состояние |
| `listing_versions` | неизменяемые версии при содержательных изменениях |
| `crawl_runs` | параметры и счётчики запусков |
| `crawl_errors` | типизированные ошибки без secrets |
| `possible_duplicates` | межплощадочные совпадения, confidence и причины |
| `checkpoints` | cursor, страница и offset внутри страницы |

Высокое межплощадочное совпадение связывается в `possible_duplicates`, но исходные строки не сливаются. Слабое совпадение остаётся `pending_review`.
