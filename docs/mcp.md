# MCP server

Проект предоставляет локальный MCP-сервер поверх того же ядра, которое используют CLI и SQLite-хранилище. MCP — это интерфейс вызова инструментов, а не отдельный способ доступа к сайтам: статусы, allowlist, ограничения источников, checkpoints и дедупликация остаются обязательными.

## Запуск

```bash
npm ci
npm run mcp
```

Сервер использует `stdio`, поэтому обычно его запускает MCP-клиент, а не пользователь вручную. В корне проекта находится готовый `.mcp.json` для Claude Code. Для Claude Desktop используйте `examples/claude-desktop-mcp.json`, заменив `<ABSOLUTE_PROJECT_PATH>` на абсолютный путь к репозиторию и при необходимости `node` на результат команды `which node`.

В stdout передаются только MCP JSON-RPC сообщения. Диагностика пишется в stderr; cookies, токены и browser state не логируются.

## Инструменты

| Tool | Назначение |
| --- | --- |
| `realestate_sources` | статусы, способы доступа и число сохранённых записей по источникам |
| `realestate_discovery` | зафиксированный discovery-отчёт |
| `realestate_search` | ограниченный поиск по нормализованному SQLite-каталогу |
| `realestate_get_listing` | полная нормализованная запись по `database_id` |
| `realestate_crawl` | разрешённый crawl одного источника или `all` с checkpoint/resume |
| `realestate_report` | статистика записей, версий, дубликатов, запусков и ошибок |
| `realestate_export` | экспорт JSONL/CSV |

`realestate_search` возвращает не больше 500 записей за вызов и поддерживает `offset`. Из результата исключается `raw_payload`; исходный очищенный текст остаётся доступным в `raw_text`.

## Facebook import

MCP не выполняет live-сбор Facebook. Разрешённый `.jsonl` или `.csv` поместите в `data/imports/`, затем вызовите:

```json
{
  "source": "facebook_groups",
  "facebook_import_file": "my-export.jsonl",
  "resume": true
}
```

Абсолютные пути и выход из `data/imports/` отклоняются.

## Проверка

`tests/aggregator/mcp.test.js` поднимает сервер отдельным процессом через официальный MCP SDK, подключает настоящий `StdioClientTransport`, вызывает инструменты и проверяет policy gate до сети.

```bash
node --test tests/aggregator/mcp.test.js
```
