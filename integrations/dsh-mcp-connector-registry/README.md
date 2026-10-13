# Карточка Ведара для каталога коннекторов DeepSeek Harness

Каталог — `duhu2000/dsh-mcp-connector-registry` (плагин `dsh-mcp-connector`, рынок
«MCP连接器» внутри DeepSeek Harness, 109 карточек на 06.10.2026). Карточка — один файл
`connectors/<id>.json`, подаётся PR из форка либо заявкой «Connector request».

`connectors/vedar.json` здесь — источник карточки; в их репозиторий уходит копия без
правок. Поля — по их `docs/ONBOARDING.md` (13.10): `auth.mode: none`, транспорт
`streamable-http`, адрес из `server.json`, категория из девяти стандартных.
Сторож: `tests/unit/dsh-integrations.test.ts`.

Перед подачей в их CI: `npm ci --legacy-peer-deps && npm test && npm run validate && npm run assets:check`
(проверка иконки ходит на `https://vedarai.ru/icons/icon-400.png`).
