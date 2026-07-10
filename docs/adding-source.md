# Adding a source

1. Добавьте источник в `config/aggregator.json`: base URL, exact domain allowlist, status, access method, limits, robots/terms links.
2. Зафиксируйте discovery и основание доступа в `docs/discovery.md`.
3. Создайте адаптер в `src/aggregator/adapters/` и зарегистрируйте его в `adapters/index.js`.
4. Извлекайте сначала официальный API/export, затем JSON-LD, embedded JSON, публичный JSON, static HTML и только потом Playwright.
5. Возвращайте нормализованные записи, проходящие `ListingSchema`. Не заполняйте отсутствующие поля догадками.
6. Выдавайте страницы с cursor и `complete`; не записывайте checkpoint раньше успешного сохранения items.
7. Устанавливайте `supports_complete_snapshot: true` только если проход действительно охватывает весь активный каталог.
8. Добавьте fixtures для каждого языка/типа и тесты extraction, pagination, retry, allowlist и resume.
9. Запустите `npm run verify:aggregator`, затем ограниченный smoke-test с 1–3 страницами.

Source-specific selectors и URL rules не должны попадать в runner, storage или normalizer. Если доступ запрещён, используйте `PolicyGatedAdapter`, а не скрытый обход.
