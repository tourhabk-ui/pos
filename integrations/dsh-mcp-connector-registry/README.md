# Карточка Ведара для каталога коннекторов DeepSeek Harness

Каталог — `duhu2000/dsh-mcp-connector-registry` (плагин `dsh-mcp-connector`, рынок
«MCP连接器» внутри DeepSeek Harness, 109 карточек на 06.10.2026). Карточка — один файл
`connectors/<id>.json`, подаётся PR из форка либо заявкой «Connector request».

`connectors/vedar.json` здесь — источник карточки; в их репозиторий уходит копия без
правок. Поля — по их `docs/ONBOARDING.md` (13.10): `auth.mode: none`, транспорт
`streamable-http`, адрес из `server.json`, категория из девяти стандартных.
Сторожа: `tests/unit/dsh-integrations.test.ts`, `tests/unit/sister-repos.test.ts`
(число видов заявок и имена пишущих инструментов — как у сервера).

**Подача — PR #44, ветка `add-vedar` нашей копии каталога.** 13.11 выяснилось, что
ветка разошлась с этим файлом: по просьбам проверяющего карточку на ветке переписали
30.10 (инструменты, меняющие состояние, и согласие на передачу имени и телефона), а
сюда правку не внесли. Здесь карточка написана заново под нынешний сервер: девять
меняющих состояние инструментов, шесть заявок, `change_request`. Кроме карточки, на
ветке лежат запись кандидата (`candidates/records/vedar.json`, описание не длиннее
500 знаков — `schema/candidate.schema.json`) и отчёт приёмки
(`docs/runtime-acceptance/pr-44/vedar.md`); их источника здесь пока нет.

Отчёт приёмки снимает их же скрипт `scripts/run-runtime-acceptance.mjs`: `initialize`,
`tools/list` и один читающий вызов. Из контейнера разработки vedarai.ru закрыт, поэтому
прогон идёт с раннера — `dsh-registry-acceptance.yml`, маркер
`.github/triggers/dsh-registry-acceptance.json` (репозиторий, полный sha и путь скрипта
приколоты). Сторож: `tests/unit/dsh-registry-acceptance.test.ts`.

Перед подачей в их CI: `npm ci --legacy-peer-deps && npm test && npm run validate && npm run assets:check`
(проверка иконки ходит на `https://vedarai.ru/icons/icon-400.png`).
