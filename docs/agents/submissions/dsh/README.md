# Подача плагина dsh-vedar в два магазина DeepSeek Harness

Готовим мы, подаёт владелец. Здесь лежат два файла ровно в том виде, в каком
их ждут чужие репозитории, — пути внутри папок повторяют пути в этих
репозиториях. Находка аудита 15.10 — CN-dsh (разведка «Китай»).

Зачем вообще подавать: тему `dsh-plugin` на GitHub читают не все. Маркет
dsh-market внутри DeepSeek Harness ставит только из курируемого реестра
awesome-dsh-plugin, а 1024Store на 15.10 dsh-vedar не подхватил
(`deepseek1024.com/plugins/tourhabk-ui/dsh-vedar` — 404).

| Магазин | Файл здесь | Куда положить там |
|---|---|---|
| awesome-dsh-plugin (дорога в dsh-market) | `awesome-dsh-plugin/data/plugins/tourhabk-ui__dsh-vedar.yml` | `data/plugins/tourhabk-ui__dsh-vedar.yml` в https://github.com/awesome-dsh-plugin/awesome-dsh-plugin |
| DSH 1024Store (deepseek1024.com) | `1024store/catalog/plugins/tourhabk-ui--dsh-vedar.json` | `catalog/plugins/tourhabk-ui--dsh-vedar.json` в https://github.com/imsai-sh/awesome-deepseek-harness-plugins |

Описание одно на оба магазина и нейтральное. Числа инструментов в нём нет
намеренно: мейнтейнер awesome-dsh-plugin сверяет описание с кодом
репозитория, а код плагина — одна строка `cordis.patch.yml`; инструменты
живут на сервере и меняются без плагина.

## До подачи

1. Правка `peerDependencies` из `integrations/dsh-vedar/package.json`
   (`"@deepseek-ai/dsh-mcp-client": ">=0.2.0-rc.1 <0.3.0-0"` вместо `"*"`)
   должна попасть в репозиторий `tourhabk-ui/dsh-vedar`. `"*"` по правилам
   semver не покрывает предрелизы моста, а DeepSeek Harness 0.2.0-rc.2 ставит
   мост ровно 0.2.0-rc.2; contributing awesome-dsh-plugin предупреждает
   именно об этом, а мейнтейнер читает код репозитория, не нашу копию.
2. По желанию, 10 секунд: https://github.com/tourhabk-ui/dsh-vedar →
   шестерёнка в About → в поле Website убрать пробел после
   `https://vedarai.ru/mcp` → Save changes. Это чинит ссылку в карточке
   dsh.market.

## awesome-dsh-plugin

Что делает владелец (GitHub, около 5 минут):

1. Открыть https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/new/main/data/plugins — GitHub сам предложит сделать форк.
2. Имя файла `tourhabk-ui__dsh-vedar.yml`, содержимое — целиком из
   `awesome-dsh-plugin/data/plugins/tourhabk-ui__dsh-vedar.yml`.
3. Propose changes → Create pull request. В PR одна запись (лимит — три).

`description.zh` не указан: по их contributing обязателен только `en`,
перевод добавляет мейнтейнер.

Что проверяет CI (по порядку): не больше трёх записей в PR; `dsh.bundle` в
`package.json` репозитория; репозиторию не меньше суток (dsh-vedar создан
13.10); `awesome-lint` и сборка сайта. Имя файла обязано совпадать с `url`
(`owner__repo.yml`), ключи — только `url`, `name`, `category`, `description`,
`tarball`. Тема `dsh-plugin` должна стоять на репозитории — стоит.

Что читает мейнтейнер до вливания: делает ли код то, что сказано в строке
(включая числа и имена API), подходит ли категория (`tools`; не `remote` —
там «Remote & Mobile» для самого dsh), настоящий ли это код, нет ли дубля,
нет ли подозрительного в исходнике, не трогает ли PR чужие записи, не
пустой ли это сборник чужих плагинов. Отказ по неточному описанию —
не отказ плагину: правят строку, и запись входит.

## 1024Store

Что делает владелец (GitHub, около 5 минут):

1. Форк https://github.com/imsai-sh/awesome-deepseek-harness-plugins (или новый файл через веб, как выше).
2. Файл `catalog/plugins/tourhabk-ui--dsh-vedar.json`, содержимое — целиком из
   `1024store/catalog/plugins/tourhabk-ui--dsh-vedar.json`.
3. Поле `added` — дата подачи PR (сейчас стоит 2026-10-15; подаётся позже —
   поменять на день подачи).
4. PR с этим одним файлом и больше ничем, **не черновиком**.

Что проверяет static-review: в PR только `catalog/plugins/*.json`; ровно
ключи `$schema`, `id`, `name`, `repository`, `category`, `description`
(`en` и `zh`), `added`; имя файла выводится из `id`; `repository` равен
`https://github.com/<id>`; категория из их `catalog/categories.json`;
описания от 1 до 1000 знаков; дата — настоящая дата. Через GitHub API
читает репозиторий: `package.json` с `dsh.bundle.patch` и сам файл patch в
той же ревизии. Код не ставит и не запускает. Прошёл — PR с одной новой
записью вливается автоматически: «There is no maintainer step».

Охват низкий: 1024Store ставит только из npm, а пакета `dsh-vedar` в npm нет
(`registry.npmjs.org/dsh-vedar` — 404). Карточка будет только для просмотра;
кнопка установки появится после `npm publish dsh-vedar` с аккаунта npm
владельца — это отдельное решение.

## Откуда формат

Сверено 15.10 по файлам самих репозиториев (raw.githubusercontent.com; API
GitHub к этим репозиториям из сессии закрыт, 403):

- awesome-dsh-plugin: `contributing.md`, `scripts/lib/entries.mjs`
  (`slugFor`, допустимые ключи и категории), `scripts/check-submission.mjs`;
- 1024Store: `CONTRIBUTING.md`, `catalog/schema/plugin.schema.json`,
  `catalog/categories.json`, `scripts/lib/catalog-entry.mjs` — их
  `validateCatalogEntry` на нашем JSON прошёл локально.

Их CI на этих файлах не запускался: он стартует только на PR в их
репозиторий. Сторож у нас — `tests/unit/dsh-integrations.test.ts`: разбирает
оба файла, держит обязательные поля, адрес репозитория, отсутствие числа
инструментов, связь каждого обещания описания с инструментом сервера и
диапазон моста в `package.json`.
