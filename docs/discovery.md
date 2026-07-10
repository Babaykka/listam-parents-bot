# Source discovery

Проверка выполнена 10 июля 2026 года ограниченными запросами к публичным страницам. Массовый сбор не запускался. Приоритет проверки: robots/terms/sitemap, структурированные экспорты, статический HTML и только затем браузер.

В текущей сессии отдельные Playwright MCP tools не были доступны в наборе инструментов Codex. Для одной JavaScript-страницы условий Banali использован установленный Playwright CLI 1.60 в видимом браузере. Это ограничение не маскируется под MCP-проверку.

## Результат

| Источник | Статус | Что фактически проверено | Стабильный ID / пагинация | Решение |
| --- | --- | --- | --- | --- |
| List.am | `not_permitted` | `robots.txt`, sitemap endpoint, официальные Terms | sitemap вернул security challenge; дальнейший discovery остановлен | сетевой адаптер блокируется до запроса |
| Banali.am | `not_permitted` | `robots.txt`, sitemap, Terms в Playwright | sitemap доступен, но выглядит неполным/устаревшим | требуется письменное согласие до копирования и хранения |
| MyRealty.am | `not_permitted` | `robots.txt`, sitemap, официальные Conditions | sitemap доступен; дальнейший listing discovery остановлен | сетевой адаптер блокируется до запроса |
| Estate.am | `partially_supported` | `robots.txt`, sitemap, четыре category URL, официальные RSS/Atom endpoints | ID имеет суффикс `-d<number>`; RSS представляет одну ограниченную ленту без next cursor | используется только официальный RSS |
| Facebook | `partially_supported` на уровне агрегатора, все 22 группы `not_permitted` для live-сбора | официальные Terms и Automated Data Collection Terms | share-ссылки не открывались автоматически; canonical URL остаются `null` | разрешён только файловый импорт |

Юридический запрет имеет приоритет над технической доступностью. Источник не считается поддержанным только потому, что отвечает главная страница или sitemap.

## List.am

- Robots: <https://www.list.am/robots.txt>
- Sitemap: <https://www.list.am/sitemap/sitemap.xml>
- Terms: <https://www.list.am/en/help/14>

Terms запрещают копирование/хранение контента и использование автоматических программ для доступа. Sitemap во время проверки показывал `Just a moment...`. Challenge не обходился. Статус: `not_permitted`.

## Banali.am

- Robots: <https://banali.am/robots.txt>
- Sitemap: <http://banali.am/sitemap.xml>
- Terms: <https://banali.am/terms-conditions>

Robots разрешает общий crawl и закрывает служебный `/nova/`. Terms резервируют копирование, публикацию, воспроизведение и использование материалов без согласия. Поэтому наличие доступного sitemap не даёт оснований сохранять объявления. Статус: `not_permitted` до письменного разрешения.

## MyRealty.am

- Robots: <https://myrealty.am/robots.txt>
- Sitemap: <http://www.myrealty.am/sitemap.xml>
- Conditions: <https://myrealty.am/en/conditions>

Robots закрывает `/api`, `/admin`, `/class` и `/config`. Conditions отдельно запрещают копирование/хранение материалов и автоматические программы. Закрытый `/api` не исследовался. Статус: `not_permitted`.

## Estate.am

- Robots: <https://www.estate.am/robots.txt>
- Sitemap: <https://www.estate.am/sitemap.xml>
- Продажа квартир: <https://www.estate.am/en/apartments-for-sale-in-yerevan-s12>
- Продажа домов: <https://www.estate.am/en/houses-and-villas-for-sale-in-yerevan-s687>
- Аренда квартир: <https://www.estate.am/en/apartments-rentals-s826>
- Аренда домов: <https://www.estate.am/en/houses-and-villas-rentals-in-yerevan-s1792>

Category pages публикуют штатные Atom/RSS links. RSS содержит `id`, alternate URL, `updated`, title, summary, HTML description и enclosure image. Извлечение выполняется XML-парсером с выключенной обработкой entities.

Важные ограничения:

- robots задаёт `Crawl-delay: 10`;
- RSS может содержать старые записи и смешанные формулировки sale/rent;
- `<updated>` сохраняется в `updated_at`, а `published_at` остаётся `null`;
- отсутствие записи в RSS не означает удаление;
- detail pages не загружаются и не копируются.

English RSS используется для структурного извлечения. Сайт также публикует `hy`, `ru` и `en` hreflang category pages, но адаптер не дублирует одну запись из трёх локализаций.

### Smoke-test 10.07.2026

- 4 официальных RSS endpoint, по одному запросу на ленту;
- 81 запись и 81 уникальный `source_listing_id`;
- 81/81 записей прошли строгую схему;
- 0 ошибок, 0 пропущенных price/area;
- итоговая классификация: 50 sale, 18 long-term rent, 13 daily rent;
- типы: 47 apartment, 30 house, 4 townhouse;
- у всех записей `published_at = null` и заполнен только доступный `updated_at`;
- повторный проход: 0 inserted, 0 updated, 81 unchanged.

Smoke-test не открывал detail pages и не выполнял обход sitemap.

## Facebook

- Terms: <https://www.facebook.com/legal/terms>
- Automated Data Collection Terms: <https://www.facebook.com/legal/automated_data_collection_terms>
- Export help: <https://www.facebook.com/help/506794473544588/>

Официальные условия требуют express written permission для automated data collection. Поэтому ни одна из 22 share-ссылок не открывалась автоматически, ручная browser session не создавалась, cookies и browser state не сохранялись. Все исходные URL сохранены в `config/facebook-groups.json`; canonical URL равны `null`, статус каждой группы — `not_permitted`.

Допустимый fallback — JSONL/CSV, который пользователь получил законным способом и имеет право обрабатывать. Импорт не открывает профили, комментарии, реакции, участников или внешние ссылки.
