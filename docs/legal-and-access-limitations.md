# Legal and access limitations

Агрегатор следует принципу deny by default: техническая доступность URL не считается разрешением на копирование и хранение данных.

## Проверенные ограничения

| Источник | Официальная страница | Текущее решение |
| --- | --- | --- |
| List.am | <https://www.list.am/en/help/14> | автоматический сбор выключен |
| Banali.am | <https://banali.am/terms-conditions> | требуется письменное согласие |
| MyRealty.am | <https://myrealty.am/en/conditions> | автоматический сбор выключен |
| Estate.am | <https://www.estate.am/robots.txt> | только опубликованные RSS, delay 10 секунд |
| Facebook | <https://www.facebook.com/legal/automated_data_collection_terms> | live-сбор выключен без express written permission |

Также применяются общие [Meta Terms](https://www.facebook.com/legal/terms). Они запрещают automated access/collection без предварительного разрешения.

## Что код не делает

- не обходит CAPTCHA, Cloudflare/WAF, 401/403, paywall или rate limit;
- не использует stealth, fingerprint spoofing, proxy rotation или чужие cookies;
- не принимает пароль через CLI и не логирует credentials/browser state;
- не вступает в Facebook-группы, не ставит реакции и не пишет комментарии;
- не собирает участников, профили, комментарии и реакции;
- не переходит по внешним ссылкам Facebook-публикаций;
- не вызывает закрытые `/api` endpoints;
- не повторяет постоянные 4xx;
- не выходит за source allowlist.

401/403 или challenge переводит источник в `blocked` и завершает проход. 429 и 5xx имеют ограниченные retries, `Retry-After`, exponential backoff и jitter.

## Facebook authorization

Видимый browser login не реализован, потому что ручной вход пользователя не отменяет требование Meta о письменном разрешении на automated collection. В текущем статусе безопасный путь — импорт данных, которые пользователь законно экспортировал и вправе обрабатывать.

После получения письменного разрешения необходимо:

1. Зафиксировать разрешённые группы, поля, частоту и срок хранения.
2. Предпочесть официальный API/экспорт, указанный Meta.
3. Добавить отдельный headed flow без передачи пароля приложению.
4. Хранить browser state локально с правами `0600` в `browser-state/`, уже исключённом из Git.
5. Немедленно останавливаться при CAPTCHA/checkpoint/security challenge.

До выполнения этих условий статус 22 групп остаётся `not_permitted`, а canonical URL не разрешаются автоматически.

## Data minimization

Estate contact URL указывает на публичную карточку. Facebook contact URL указывает на публикацию. Телефоны и email в Facebook-импорте по умолчанию редактируются, а произвольные поля входного файла не переносятся в `raw_payload`. Неоднозначные поля остаются `null`, точная геолокация не выводится из неполного адреса.
