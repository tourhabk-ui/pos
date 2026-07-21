# Реорг · Этап 0 — Инвентаризация (страницы + lib)

> READ-ONLY отчёт. Ноль изменений кода. «Мёртвое» = 0 входящих импортов И 0 ссылок из навигации — это **список кандидатов, не на удаление**. Удаление — Этап 10, только по пофайловому подтверждению.

**Сгенерировано:** 2026-07-21T13:45:43.073Z · **Просканировано файлов:** 1586 · **lib-модулей:** 315 · **страниц:** 203

## Метод

- Построен реальный граф импортов: каждый `import`/`require`/динамический `import()` резолвится в файл (alias `@/*` → корень, относительные пути, `index`-barrel, NodeNext `.js`→`.ts`). Тёзки не путаются — сверка по резолвнутому пути, не по basename.
- Входящие для lib-модуля = число файлов, реально импортирующих его. Скрипты (`scripts/`), корневые точки входа (`middleware.ts`, `next.config.js`, `start.js`) включены в скан.
- Для страниц импорт почти всегда 0 (это точки входа по URL), поэтому сигнал — **nav-ссылка**: маршрут упомянут в `href`/`push`/`redirect` где-либо в коде.

### Ограничения (честно)

- **nav-детекция ловит только литеральные строки** `href="/x"`. Меню, построенные из конфиг-массива (`href={item.path}`), она НЕ видит → многие `/hub/*` в списке «без nav» на деле в динамическом меню. Поэтому hub-страницы помечены «проверить», а не «мёртвые».
- Точки входа не через import (CLI `tsx`, MCP-серверы-процессы, крон-эндпоинты) выглядят как 0 входящих — размечены отдельным вердиктом ЖИВОЙ.
- Строковые/динамические ссылки на модули (реестры по имени) граф не считает импортом — отмечено там, где замечено.

## lib — сводка

| Всего | Живых (≥1 входящий вне тестов) | 0 входящих (кандидаты) |
|---|---|---|
| 315 | 299 | 16 |

### lib — кандидаты (0 входящих), классифицировано

| Модуль | Строк | Вердикт | Обоснование |
|---|--:|---|---|
| `lib/agents/agencies/admin-agency.ts` | 1 | СИРОТА? · кластер agents | Ссылается только строкой из scheduler.ts (который сам мёртв). 1 строка. |
| `lib/agents/agencies/eco-agency.ts` | 1 | СИРОТА? · кластер agents | Как admin-agency: только строка в мёртвом scheduler.ts. |
| `lib/agents/agencies/security-agency.ts` | 1 | СИРОТА? · кластер agents | Как admin-agency: только строка в мёртвом scheduler.ts. |
| `lib/database/index.ts` | 15 | МЁРТВЫЙ BARREL · Этап 1 | Barrel lib/database с 0 входящих; потребители импортируют вглубь / lib/db-pool. |
| `lib/planner/index.ts` | 65 | МЁРТВЫЙ BARREL · Этап 2 | CLAUDE.md зовёт lib/planner точкой входа, но реально импортируют @/lib/planner/* вглубь. |
| `lib/agents/tools/types.ts` | 72 | СИРОТА? · кластер agents | Типы инструментов агентов; 0 входящих через резолв. Проверить связь с реальным стеком. |
| `lib/agents/managed/client.ts` | 91 | СИРОТА? · кластер agents | Клиент managed-агентов; 0 входящих. Подтвердить. |
| `lib/events/subscribers.ts` | 112 | СИРОТА? · Этап 10 | Подписчики событий; 0 входящих — событийная шина, похоже, не подключена. |
| `lib/database/migrate.ts` | 171 | ЖИВОЙ · CLI | package.json → `tsx lib/database/migrate.ts` (`npm run migrate`). Не импорт — процесс. |
| `lib/middleware/validation.ts` | 193 | КАНДИДАТ · Этап 10 | 0 входящих через резолв. Проверить, не дублирует ли Zod-валидацию в роутах. |
| `lib/env.ts` | 200 | СИРОТА? · Этап 10 | Единственная ссылка — в собственном JSDoc-примере. Реального импортёра нет. Подтвердить. |
| `lib/mcp/kamchatka-data/server.ts` | 251 | ЖИВОЙ · MCP-сервер | Standalone-процесс, сам импортирует ./sources/*. Проверить, чем запускается. |
| `lib/monitoring.ts` | 278 | МЁРТВЫЙ ДУБЛЬ · Этап 1 | Плоский файл при живой lib/monitoring/. Потребители тянут @/lib/monitoring/logger. |
| `lib/middleware/rate-limit.ts` | 288 | КАНДИДАТ · Этап 10 | 0 входящих; edge rate-limit живёт в корневом middleware.ts (§7, заморожен). Возможен мёртвый дубль. |
| `lib/agents/scheduler.ts` | 391 | СИРОТА? · кластер agents | 0 входящих, нет крон/API-вызова. Голова кластера мёртвого «совета». |
| `lib/mcp/dev-tools/server.ts` | 427 | ЖИВОЙ? · MCP dev | MCP-сервер dev-инструментов. Вероятно dev-only. Подтвердить запуск/нужность. |

**Итог по lib-кандидатам:** 3 — живые точки входа (не трогать), 2 — мёртвые barrel'ы (Этап 1/2), 1 — мёртвый дубль (Этап 1), ~10 — сироты-кандидаты (в основном кластер `agents/` мёртвого «совета» + служебные), подтверждать пофайлово в Этапе 10.

## Страницы — сводка

| Всего | С nav-ссылкой | Без литеральной nav (проверить) |
|---|---|---|
| 203 | 171 | 32 |

### Страницы — кандидаты (без литеральной nav), классифицировано

| Маршрут | Строк | Вердикт | Заметка |
|---|--:|---|---|
| `/hub/admin/telegram` | 4 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/admin/moderation` | 5 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/agent/stats` | 5 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/operator/guides` | 5 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/transfer-operator/bookings` | 5 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/tp-verify` | 8 | ЖИВАЯ · верификация | Travelpayouts verification (см. meta travelpayouts-verification). Служебная. |
| `/dashboard` | 9 | КАНДИДАТ · Этап 9 | Похоже на legacy-дубль /hub. Проверить редирект/нужность. |
| `/hub/admin/photos` | 11 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/admin/routes-analysis` | 11 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/operator/ai-assist` | 11 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/admin/places` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/admin/support` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/operator/booking-intake` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/operator/register` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/transfer` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/transfer-operator/routes` | 12 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/routes/detail/[id]` | 12 | ЖИВАЯ · redirect | redirect(`/routes/${id}`) — legacy-URL на канон. Свернуть в Этап 9 (301). |
| `/hub/agent/onboarding` | 13 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/gear/onboarding` | 13 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/guide/onboarding` | 13 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/cart` | 18 | КАНДИДАТ · Этап 9 | Возможен дубль /hub/tourist/cart. Проверить, куда ведёт кнопка корзины. |
| `/p/[code]` | 20 | ЖИВАЯ · внешний вход | Короткая ссылка по коду. Внешний вход. |
| `/home-v7` | 23 | КАНДИДАТ · Этап 2 | noindex-превью v8. Главная рендерится app/page.tsx из ./home-v7/. Сам роут — превью, убрать при переезде home-v7→_home. |
| `/kuzmich/hub` | 23 | КАНДИДАТ · проверить | Отдельный хаб Кузьмича; не в литеральной nav. Проверить нужность/ссылки. |
| `/transparency` | 30 | КАНДИДАТ · проверить | Standalone-страница; nav-регекс мог пропустить ссылку из футера-массива. Проверить. |
| `/trip/[token]` | 44 | ЖИВАЯ · внешний вход | Deep-link по токену (письмо/ссылка). Внутренней nav нет by design. |
| `/hub/admin/telegram/webhook` | 113 | ЖИВАЯ? · admin-инструмент | Служебная админ-страница вебхука. По URL, вне меню. |
| `/catalog/tours/[id]` | 163 | КАНДИДАТ · Этап 9 | Дубль карточки тура (/marketplace|/tours). Свести 301, как делали для маршрутов. |
| `/hub/admin/enrich-places` | 193 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/hub/admin/videos` | 225 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |
| `/widget/lead-form/[slug]` | 246 | ЖИВАЯ · встраиваемый виджет | Embed-виджет лид-формы для внешних сайтов. Внутренней nav нет by design. |
| `/hub/admin/content/routes` | 507 | ADMIN/HUB · вне литерального меню | Роль-гейт страница; вероятно в динамическом меню хаба (`app/hub/admin/layout.tsx` и т.п.). Проверить, что в меню и нужна. |

**Итог по страницам:** 4 — внешние точки входа (живы by design: токен/код/verify/виджет), 1 — redirect-заглушка, 1 — превью (Этап 2), ~5 — legacy-дубли на 301 (Этап 9), ~20 — admin/hub-страницы вне литерального меню (проверить, скорее всего живы через динамическое меню).

## Приложение A — полный список lib (315), сортировка по входящим

| Модуль | Строк | Вход. (вне тестов) | Вердикт |
|---|--:|--:|---|
| `lib/agents/agencies/admin-agency.ts` | 1 | 0 | DEAD? |
| `lib/agents/agencies/eco-agency.ts` | 1 | 0 | DEAD? |
| `lib/agents/agencies/security-agency.ts` | 1 | 0 | DEAD? |
| `lib/database/index.ts` | 15 | 0 | DEAD? |
| `lib/planner/index.ts` | 65 | 0 | DEAD? |
| `lib/agents/tools/types.ts` | 72 | 0 | DEAD? |
| `lib/agents/managed/client.ts` | 91 | 0 | DEAD? |
| `lib/events/subscribers.ts` | 112 | 0 | DEAD? |
| `lib/database/migrate.ts` | 171 | 0 | DEAD? |
| `lib/middleware/validation.ts` | 193 | 0 | DEAD? |
| `lib/env.ts` | 200 | 0 | DEAD? |
| `lib/mcp/kamchatka-data/server.ts` | 251 | 0 | DEAD? |
| `lib/monitoring.ts` | 278 | 0 | DEAD? |
| `lib/middleware/rate-limit.ts` | 288 | 0 | DEAD? |
| `lib/agents/scheduler.ts` | 391 | 0 | DEAD? |
| `lib/mcp/dev-tools/server.ts` | 427 | 0 | DEAD? |
| `lib/mesh/victim-ip.ts` | 35 | 1 | alive |
| `lib/services/query-expansion-health.ts` | 42 | 1 | alive |
| `lib/agents/permissions.ts` | 44 | 1 | alive |
| `lib/services/rescue-coverage.ts` | 45 | 1 | alive |
| `lib/routes/geometry-compact.ts` | 46 | 1 | alive |
| `lib/services/_errors.ts` | 47 | 1 | alive |
| `lib/kuzmich/history-compaction.ts` | 51 | 1 | alive |
| `lib/ai/fetchAsMarkdown.ts` | 54 | 1 | alive |
| `lib/agents/evo/alert.ts` | 57 | 1 | alive |
| `lib/agents/orchestrator.ts` | 57 | 1 | alive |
| `lib/booking/stay-price.ts` | 62 | 1 | alive |
| `lib/services/route-preflight-safety.ts` | 63 | 1 | alive |
| `lib/kuzmich/accommodation-search.ts` | 66 | 1 | alive |
| `lib/kuzmich/transfer-search.ts` | 66 | 1 | alive |
| `lib/routes/catalog-sitemap.ts` | 68 | 1 | alive |
| `lib/encryption.ts` | 69 | 1 | alive |
| `lib/kuzmich/gear-search.ts` | 69 | 1 | alive |
| `lib/services/mistral-ocr.ts` | 69 | 1 | alive |
| `lib/services/places-quality.ts` | 71 | 1 | alive |
| `lib/services/routes-geometry-health.ts` | 71 | 1 | alive |
| `lib/mesh/signaling-store.ts` | 72 | 1 | alive |
| `lib/ai/markdown-new.ts` | 74 | 1 | alive |
| `lib/ai/query-expansion.ts` | 80 | 1 | alive |
| `lib/routes/operational-alerts.ts` | 80 | 1 | alive |
| `lib/mcp/kamchatka-data/sources/mches-telegram.ts` | 81 | 1 | alive |
| `lib/agents/eval/live-questions.ts` | 83 | 1 | alive |
| `lib/planner-constants.ts` | 84 | 1 | alive |
| `lib/routing/subgraph.ts` | 88 | 1 | alive |
| `lib/kuzmich/context-budget.ts` | 90 | 1 | alive |
| `lib/services/payment.service.ts` | 92 | 1 | alive |
| `lib/kuzmich/tool-loop.ts` | 93 | 1 | alive |
| `lib/sales/messages.ts` | 95 | 1 | alive |
| `lib/channels/channel-manager.ts` | 98 | 1 | alive |
| `lib/monitoring/logger.ts` | 98 | 1 | alive |
| `lib/seo/ssr-sentinel.ts` | 98 | 1 | alive |
| `lib/telegram/industry-channels.ts` | 100 | 1 | alive |
| `lib/payments/binance-client.ts` | 102 | 1 | alive |
| `lib/services/analytics.service.ts` | 102 | 1 | alive |
| `lib/errors/api-handler.ts` | 103 | 1 | alive |
| `lib/agents/memory/memory-bridge.ts` | 106 | 1 | alive |
| `lib/partners/kamchatka-fishing/sync.ts` | 110 | 1 | alive |
| `lib/parks/permit-matrix.ts` | 111 | 1 | alive |
| `lib/services/booking-funnel-stages.ts` | 112 | 1 | alive |
| `lib/agents/agencies/lead-agency.ts` | 115 | 1 | alive |
| `lib/services/rag.service.ts` | 116 | 1 | alive |
| `lib/agents/agencies/tourist-agency.ts` | 124 | 1 | alive |
| `lib/services/hotels.service.ts` | 124 | 1 | alive |
| `lib/import/passport-ocr-runner.ts` | 126 | 1 | alive |
| `lib/email.ts` | 128 | 1 | alive |
| `lib/services/transfers.service.ts` | 129 | 1 | alive |
| `lib/safety/mchs-client.ts` | 130 | 1 | alive |
| `lib/import/passport-enrich-runner.ts` | 138 | 1 | alive |
| `lib/operators/structurer.ts` | 140 | 1 | alive |
| `lib/services/search.service.ts` | 140 | 1 | alive |
| `lib/agents/eval/editor-regression.ts` | 141 | 1 | alive |
| `lib/mcp/kamchatka-data/sources/local-vk.ts` | 143 | 1 | alive |
| `lib/channels/tripster.ts` | 146 | 1 | alive |
| `lib/agents/agencies/marketing-agency.ts` | 151 | 1 | alive |
| `lib/notifications/booking-notifications.ts` | 152 | 1 | alive |
| `lib/integrations/uon.ts` | 153 | 1 | alive |
| `lib/safety/checkin-escalation.ts` | 154 | 1 | alive |
| `lib/ai/image-tagger.ts` | 155 | 1 | alive |
| `lib/telegram/booking-notify.ts` | 157 | 1 | alive |
| `lib/agents/memory-contradiction.ts` | 158 | 1 | alive |
| `lib/services/insurance.service.ts` | 158 | 1 | alive |
| `lib/safety/safety-selfcheck.ts` | 160 | 1 | alive |
| `lib/admin/alerts.ts` | 162 | 1 | alive |
| `lib/import/passport-fields.ts` | 162 | 1 | alive |
| `lib/mcp/kamchatka-data/sources/tourism-db.ts` | 162 | 1 | alive |
| `lib/services/route-description-cache.ts` | 165 | 1 | alive |
| `lib/services/flights.service.ts` | 166 | 1 | alive |
| `lib/channels/yandex.ts` | 167 | 1 | alive |
| `lib/import/route-passports.ts` | 168 | 1 | alive |
| `lib/services/partner.service.ts` | 168 | 1 | alive |
| `lib/agents/evo/feedback-loop.ts` | 176 | 1 | alive |
| `lib/agents/agencies/transfer-operator-agency.ts` | 177 | 1 | alive |
| `lib/search/tour-search.ts` | 196 | 1 | alive |
| `lib/services/data-inventory.ts` | 198 | 1 | alive |
| `lib/agents/kuzmich-place-enricher.ts` | 199 | 1 | alive |
| `lib/agents/kamchatkaland-importer.ts` | 202 | 1 | alive |
| `lib/pdf/voucher-generator.ts` | 204 | 1 | alive |
| `lib/services/operator-tour-scraper.ts` | 212 | 1 | alive |
| `lib/services/emergency-contacts.ts` | 213 | 1 | alive |
| `lib/payments/tochka.ts` | 214 | 1 | alive |
| `lib/services/wikimedia-photos.ts` | 214 | 1 | alive |
| `lib/pdf/contract-generator.ts` | 218 | 1 | alive |
| `lib/services/travelpayouts.ts` | 222 | 1 | alive |
| `lib/agents/eval/kuzmich-redteam.ts` | 226 | 1 | alive |
| `lib/agents/execution/handlers/ab-scale-executor.ts` | 226 | 1 | alive |
| `lib/middleware/csrf.ts` | 229 | 1 | alive |
| `lib/services/support.service.ts` | 233 | 1 | alive |
| `lib/services/booking.service.ts` | 234 | 1 | alive |
| `lib/services/notification.service.ts` | 246 | 1 | alive |
| `lib/kuzmich/tool-schemas.ts` | 261 | 1 | alive |
| `lib/agents/agencies/rescue-agency.ts` | 263 | 1 | alive |
| `lib/agents/evo/evolver-analysis.ts` | 263 | 1 | alive |
| `lib/agents/execution/handlers/operator-outreach-executor.ts` | 263 | 1 | alive |
| `lib/pdf/proposal-generator.ts` | 267 | 1 | alive |
| `lib/services/visitkamchatka-importer.ts` | 270 | 1 | alive |
| `lib/agents/sdk/operator-tools.ts` | 279 | 1 | alive |
| `lib/notifications/sms.ts` | 280 | 1 | alive |
| `lib/agents/agencies/guide-agency.ts` | 286 | 1 | alive |
| `lib/notifications/post-validation.ts` | 289 | 1 | alive |
| `lib/agents/places-enricher.ts` | 291 | 1 | alive |
| `lib/agents/visitkamchatka-importer.ts` | 293 | 1 | alive |
| `lib/sales/bot-ceo.ts` | 296 | 1 | alive |
| `lib/validation/support-schemas.ts` | 304 | 1 | alive |
| `lib/services/visitkamchatka-audit.ts` | 308 | 1 | alive |
| `lib/services/operator-registry.service.ts` | 311 | 1 | alive |
| `lib/services/osm-traces-scout.ts` | 315 | 1 | alive |
| `lib/services/visitkamchatka-guides.ts` | 321 | 1 | alive |
| `lib/services/review.service.ts` | 324 | 1 | alive |
| `lib/pdf/place-card-generator.ts` | 335 | 1 | alive |
| `lib/search/tour-recommend.ts` | 337 | 1 | alive |
| `lib/telegram/group-scout.ts` | 340 | 1 | alive |
| `lib/safety/hazard-signals.ts` | 372 | 1 | alive |
| `lib/agents/agencies/danger-analyst-agency.ts` | 395 | 1 | alive |
| `lib/mesh/volcano-mesh.ts` | 410 | 1 | alive |
| `lib/services/visitkamchatka-operators.ts` | 425 | 1 | alive |
| `lib/notifications/email-templates.ts` | 457 | 1 | alive |
| `lib/transfers/matching.ts` | 469 | 1 | alive |
| `lib/notifications/email.ts` | 478 | 1 | alive |
| `lib/partners/kamchatka-fishing/tours-data.ts` | 486 | 1 | alive |
| `lib/agents/sdk/tourist-tools.ts` | 537 | 1 | alive |
| `lib/agents/execution/handlers/code-change-executor.ts` | 549 | 1 | alive |
| `lib/ai/crew-agents.ts` | 643 | 1 | alive |
| `lib/services/tours-visitkamchatka.ts` | 671 | 1 | alive |
| `lib/agents/tools/agent-toolkits.ts` | 733 | 1 | alive |
| `lib/services/seismic-parser.ts` | 869 | 1 | alive |
| `lib/services/data-repair.ts` | 925 | 1 | alive |
| `lib/tours/marketplace-constants.ts` | 14 | 2 | alive |
| `lib/pdf/pdf-token.ts` | 25 | 2 | alive |
| `lib/agents/index.ts` | 29 | 2 | alive |
| `lib/types/statuses.ts` | 39 | 2 | alive |
| `lib/services/offline-readiness.ts` | 52 | 2 | alive |
| `lib/agents/tools/taaft-search.ts` | 58 | 2 | alive |
| `lib/leads/scoring.ts` | 58 | 2 | alive |
| `lib/geo/kamchatka.ts` | 60 | 2 | alive |
| `lib/stay/refund-policy.ts` | 60 | 2 | alive |
| `lib/ai/interest-extractor.ts` | 63 | 2 | alive |
| `lib/stats/platform-counts.ts` | 67 | 2 | alive |
| `lib/routes/track.ts` | 68 | 2 | alive |
| `lib/agents/eval/grounding.ts` | 69 | 2 | alive |
| `lib/telegram/connect-token.ts` | 72 | 2 | alive |
| `lib/routes/audit.ts` | 74 | 2 | alive |
| `lib/ai/tourist-demand-aggregator.ts` | 80 | 2 | alive |
| `lib/ai/verbalized-sampling.ts` | 81 | 2 | alive |
| `lib/import/osm-geometry.ts` | 84 | 2 | alive |
| `lib/agents/safeguards/audit-log.ts` | 87 | 2 | alive |
| `lib/notifications/lead-notify.ts` | 91 | 2 | alive |
| `lib/agents/observation-logger.ts` | 93 | 2 | alive |
| `lib/import/elevation-profile.ts` | 99 | 2 | alive |
| `lib/tours/marketplace-page.ts` | 105 | 2 | alive |
| `lib/agents/eval/editor-judge.ts` | 108 | 2 | alive |
| `lib/operators/list-query.ts` | 108 | 2 | alive |
| `lib/ai/route-knowledge.ts` | 109 | 2 | alive |
| `lib/compute-fund.ts` | 109 | 2 | alive |
| `lib/services/seismic-feed.ts` | 116 | 2 | alive |
| `lib/support/categorize.ts` | 119 | 2 | alive |
| `lib/ai/booking-intent.ts` | 123 | 2 | alive |
| `lib/telegram/welcome.ts` | 143 | 2 | alive |
| `lib/services/visitkamchatka-gpx-importer.ts` | 145 | 2 | alive |
| `lib/services/air-quality.ts` | 146 | 2 | alive |
| `lib/agents/kvert-sync.ts` | 148 | 2 | alive |
| `lib/agents/managed/kuzmich-outcomes.ts` | 152 | 2 | alive |
| `lib/events/agent-bus.ts` | 158 | 2 | alive |
| `lib/import/osm-import-runner.ts` | 158 | 2 | alive |
| `lib/agents/memory-reflector.ts` | 161 | 2 | alive |
| `lib/services/ai-image-generator.ts` | 172 | 2 | alive |
| `lib/channels/avito.ts` | 176 | 2 | alive |
| `lib/agents/eval/kuzmich-faithfulness.ts` | 185 | 2 | alive |
| `lib/kuzmich/engagement.ts` | 197 | 2 | alive |
| `lib/partners/kamchatka-fishing/client.ts` | 200 | 2 | alive |
| `lib/routing/astar.ts` | 214 | 2 | alive |
| `lib/agents/smoke-test.ts` | 216 | 2 | alive |
| `lib/agents/evo/evolution-loop.ts` | 226 | 2 | alive |
| `lib/services/legislation-importer.ts` | 240 | 2 | alive |
| `lib/kuzmich/operator-chat.ts` | 241 | 2 | alive |
| `lib/services/dynamic-pricing.ts` | 269 | 2 | alive |
| `lib/agents/repo-scanner.ts` | 277 | 2 | alive |
| `lib/kuzmich/guardian-context.ts` | 293 | 2 | alive |
| `lib/agents/evo/growth-agent.ts` | 336 | 2 | alive |
| `lib/agents/watchdog.ts` | 347 | 2 | alive |
| `lib/services/tour.service.ts` | 355 | 2 | alive |
| `lib/agents/agencies/operator-agency.ts` | 386 | 2 | alive |
| `lib/planner/data.ts` | 392 | 2 | alive |
| `lib/agents/tools/board-executor-tools.ts` | 399 | 2 | alive |
| `lib/planner/compose.ts` | 443 | 2 | alive |
| `lib/ai/user-memory.ts` | 454 | 2 | alive |
| `lib/agents/scout-digest.ts` | 470 | 2 | alive |
| `lib/payments/transfer-payments.ts` | 514 | 2 | alive |
| `lib/transfers/booking.ts` | 526 | 2 | alive |
| `lib/agents/scout-innovator.ts` | 670 | 2 | alive |
| `lib/agents/execution/initiative-executor.ts` | 1128 | 2 | alive |
| `lib/partners/kamchatka-fishing/index.ts` | 3 | 3 | alive |
| `lib/routes/zone-meta.ts` | 23 | 3 | alive |
| `lib/mesh/types.ts` | 44 | 3 | alive |
| `lib/mesh/rooms.ts` | 50 | 3 | alive |
| `lib/utils/text-similarity.ts` | 52 | 3 | alive |
| `lib/telegram/mtproto-client.ts` | 70 | 3 | alive |
| `lib/auth/role-switch.ts` | 73 | 3 | alive |
| `lib/places/audit.ts` | 84 | 3 | alive |
| `lib/analytics/lead-tracking.ts` | 88 | 3 | alive |
| `lib/notifications/web-push.ts` | 98 | 3 | alive |
| `lib/stats/element-groups.ts` | 102 | 3 | alive |
| `lib/offline/tiles.ts` | 103 | 3 | alive |
| `lib/notifications/stay-booking.ts` | 104 | 3 | alive |
| `lib/telegram/admin-notify.ts` | 104 | 3 | alive |
| `lib/safety/geofence.ts` | 121 | 3 | alive |
| `lib/offline/pending-queue.ts` | 122 | 3 | alive |
| `lib/octo/webhooks.ts` | 159 | 3 | alive |
| `lib/services/kvert-vona.ts` | 174 | 3 | alive |
| `lib/ai/embeddings.ts` | 184 | 3 | alive |
| `lib/offline/useOfflineRegion.ts` | 229 | 3 | alive |
| `lib/offline/db.ts` | 230 | 3 | alive |
| `lib/fish-species.ts` | 238 | 3 | alive |
| `lib/agents/intent-classifier.ts` | 275 | 3 | alive |
| `lib/agents/safeguards/approval-required.ts` | 283 | 3 | alive |
| `lib/agents/sdk/sdk-runner.ts` | 312 | 3 | alive |
| `lib/ai/rag-context.ts` | 321 | 3 | alive |
| `lib/payments/cloudpayments-webhook.ts` | 328 | 3 | alive |
| `lib/stay/accommodation-types.ts` | 21 | 4 | alive |
| `lib/platform-settings.ts` | 23 | 4 | alive |
| `lib/services/profanity-filter.ts` | 38 | 4 | alive |
| `lib/pdf/fonts.ts` | 46 | 4 | alive |
| `lib/ai/usage-context.ts` | 73 | 4 | alive |
| `lib/services/geocode.ts` | 79 | 4 | alive |
| `lib/notifications/operator-booking.ts` | 127 | 4 | alive |
| `lib/notifications/max-channel.ts` | 132 | 4 | alive |
| `lib/routes/category-meta.ts` | 141 | 4 | alive |
| `lib/agents/learning/experiment-tracker.ts` | 202 | 4 | alive |
| `lib/agents/warmup.ts` | 246 | 4 | alive |
| `lib/agents/editor.ts` | 264 | 4 | alive |
| `lib/agents/evo/rescue-agent.ts` | 310 | 4 | alive |
| `lib/routes/catalog-query.ts` | 370 | 4 | alive |
| `lib/telegram/group-monitor.ts` | 390 | 4 | alive |
| `lib/services/idilesom-importer.ts` | 794 | 4 | alive |
| `lib/stay/room-types.ts` | 19 | 5 | alive |
| `lib/auth/role-routes.ts` | 21 | 5 | alive |
| `lib/auth/partner-profile.ts` | 59 | 5 | alive |
| `lib/services/firecrawl.ts` | 81 | 5 | alive |
| `lib/services/zone-weather.ts` | 123 | 5 | alive |
| `lib/leads/create.ts` | 127 | 5 | alive |
| `lib/geo/regions.ts` | 181 | 5 | alive |
| `lib/planner/intelligence.ts` | 183 | 5 | alive |
| `lib/support/ticket.service.ts` | 217 | 5 | alive |
| `lib/api/operator-tours.ts` | 267 | 5 | alive |
| `lib/agents/platform-agent.ts` | 395 | 5 | alive |
| `lib/services/chat.service.ts` | 395 | 5 | alive |
| `lib/telegram/operator-availability.ts` | 458 | 5 | alive |
| `lib/planner/engine.ts` | 1417 | 5 | alive |
| `lib/events/emit.ts` | 33 | 6 | alive |
| `lib/channels/types.ts` | 66 | 6 | alive |
| `lib/octo/schemas.ts` | 100 | 6 | alive |
| `lib/ai/provider-config.ts` | 142 | 6 | alive |
| `lib/safety/sos-detector.ts` | 147 | 6 | alive |
| `lib/search/index.ts` | 29 | 7 | alive |
| `lib/storage/s3.ts` | 113 | 7 | alive |
| `lib/planner/interests.ts` | 321 | 7 | alive |
| `lib/auth/tourist-helpers.ts` | 376 | 7 | alive |
| `lib/auth/gear-helpers.ts` | 496 | 7 | alive |
| `lib/services/intelligence-monitor.service.ts` | 883 | 7 | alive |
| `lib/agents/context-hub.ts` | 141 | 8 | alive |
| `lib/auth/guide-helpers.ts` | 550 | 8 | alive |
| `lib/auth/password.ts` | 52 | 9 | alive |
| `lib/bookings/booking.service.ts` | 731 | 9 | alive |
| `lib/auth/stay-helpers.ts` | 68 | 10 | alive |
| `lib/services/_helpers.ts` | 87 | 10 | alive |
| `lib/safety/emergency-numbers.ts` | 89 | 10 | alive |
| `lib/agents/memory/agent-knowledge.ts` | 277 | 10 | alive |
| `lib/loyalty/loyalty-system.ts` | 397 | 10 | alive |
| `lib/notifications/telegram-channel.ts` | 1026 | 10 | alive |
| `lib/octo/auth.ts` | 126 | 11 | alive |
| `lib/octo/mappers.ts` | 340 | 11 | alive |
| `lib/octo/service.ts` | 476 | 11 | alive |
| `lib/services/lead-processor.service.ts` | 713 | 11 | alive |
| `lib/kuzmich/core.ts` | 1917 | 11 | alive |
| `lib/scraping/brightdata.ts` | 153 | 12 | alive |
| `lib/notifications/email-service.ts` | 397 | 13 | alive |
| `lib/notifications/telegram.ts` | 435 | 13 | alive |
| `lib/agents/run-logger.ts` | 57 | 14 | alive |
| `lib/auth/transfer-helpers.ts` | 494 | 14 | alive |
| `lib/agents/memory/agent-memory.ts` | 365 | 16 | alive |
| `lib/ai/agent-models.ts` | 85 | 17 | alive |
| `lib/errors/sanitize.ts` | 110 | 18 | alive |
| `lib/config.ts` | 297 | 20 | alive |
| `lib/services/index.ts` | 49 | 22 | alive |
| `lib/auth/jwt.ts` | 156 | 23 | alive |
| `lib/auth.ts` | 187 | 28 | alive |
| `lib/auth/operator-helpers.ts` | 356 | 31 | alive |
| `lib/rate-limit.ts` | 92 | 39 | alive |
| `lib/ai/prompts.ts` | 104 | 53 | alive |
| `lib/security/timing-safe.ts` | 44 | 60 | alive |
| `lib/types/db-rows.ts` | 1477 | 61 | alive |
| `lib/auth/cron.ts` | 33 | 64 | alive |
| `lib/ai/providers.ts` | 2333 | 79 | alive |
| `lib/database.ts` | 304 | 283 | alive |
| `lib/db-pool.ts` | 77 | 324 | alive |
| `lib/auth/middleware.ts` | 93 | 336 | alive |

## Приложение B — полный список страниц (203)

| Маршрут | Строк | nav-ссылка | Вердикт |
|---|--:|:--:|---|
| `/hub/admin/telegram` | 4 | — | NO-NAV? |
| `/hub/admin/moderation` | 5 | — | NO-NAV? |
| `/hub/agent/stats` | 5 | — | NO-NAV? |
| `/hub/operator/guides` | 5 | — | NO-NAV? |
| `/hub/transfer-operator/bookings` | 5 | — | NO-NAV? |
| `/tp-verify` | 8 | — | NO-NAV? |
| `/dashboard` | 9 | — | NO-NAV? |
| `/hub/admin/photos` | 11 | — | NO-NAV? |
| `/hub/admin/routes-analysis` | 11 | — | NO-NAV? |
| `/hub/operator/ai-assist` | 11 | — | NO-NAV? |
| `/hub/admin/places` | 12 | — | NO-NAV? |
| `/hub/admin/support` | 12 | — | NO-NAV? |
| `/hub/operator/booking-intake` | 12 | — | NO-NAV? |
| `/hub/operator/register` | 12 | — | NO-NAV? |
| `/hub/transfer` | 12 | — | NO-NAV? |
| `/hub/transfer-operator/routes` | 12 | — | NO-NAV? |
| `/routes/detail/[id]` | 12 | — | NO-NAV? |
| `/hub/agent/onboarding` | 13 | — | NO-NAV? |
| `/hub/gear/onboarding` | 13 | — | NO-NAV? |
| `/hub/guide/onboarding` | 13 | — | NO-NAV? |
| `/cart` | 18 | — | NO-NAV? |
| `/p/[code]` | 20 | — | NO-NAV? |
| `/home-v7` | 23 | — | NO-NAV? |
| `/kuzmich/hub` | 23 | — | NO-NAV? |
| `/transparency` | 30 | — | NO-NAV? |
| `/trip/[token]` | 44 | — | NO-NAV? |
| `/hub/admin/telegram/webhook` | 113 | — | NO-NAV? |
| `/catalog/tours/[id]` | 163 | — | NO-NAV? |
| `/hub/admin/enrich-places` | 193 | — | NO-NAV? |
| `/hub/admin/videos` | 225 | — | NO-NAV? |
| `/widget/lead-form/[slug]` | 246 | — | NO-NAV? |
| `/hub/admin/content/routes` | 507 | — | NO-NAV? |
| `/hub/admin/bookings` | 5 | да | linked |
| `/hub/admin/operators` | 5 | да | linked |
| `/hub/operator/analytics` | 5 | да | linked |
| `/hub/operator/notifications` | 5 | да | linked |
| `/hub/admin/email` | 8 | да | linked |
| `/hub/admin/intelligence` | 9 | да | linked |
| `/hub/admin/agents` | 11 | да | linked |
| `/hub/admin/artem` | 11 | да | linked |
| `/hub/admin/integrations` | 11 | да | linked |
| `/hub/admin/pricing` | 11 | да | linked |
| `/hub/admin/user-photos` | 11 | да | linked |
| `/hub/guide/tours` | 11 | да | linked |
| `/hub/operator/help` | 11 | да | linked |
| `/hub/operator/leads` | 11 | да | linked |
| `/hub/operator/onboarding` | 11 | да | linked |
| `/ai-assistant` | 12 | да | linked |
| `/auth/login` | 12 | да | linked |
| `/auth/register-operator` | 12 | да | linked |
| `/booking-success/[id]` | 12 | да | linked |
| `/calendar` | 12 | да | linked |
| `/collections` | 12 | да | linked |
| `/help/operators` | 12 | да | linked |
| `/help/tourists` | 12 | да | linked |
| `/hub/admin/ai-analytics` | 12 | да | linked |
| `/hub/admin/ai-prompts` | 12 | да | linked |
| `/hub/admin/brain` | 12 | да | linked |
| `/hub/admin/leads` | 12 | да | linked |
| `/hub/admin/outreach` | 12 | да | linked |
| `/hub/admin/places-photos` | 12 | да | linked |
| `/hub/admin/taaft` | 12 | да | linked |
| `/hub/agent/find` | 12 | да | linked |
| `/hub/agent/leads` | 12 | да | linked |
| `/hub/guide/profile` | 12 | да | linked |
| `/hub/guide/reviews` | 12 | да | linked |
| `/hub/operator/profile` | 12 | да | linked |
| `/hub/operator/selections` | 12 | да | linked |
| `/hub/operator/tours/import` | 12 | да | linked |
| `/hub/operator/transfers` | 12 | да | linked |
| `/hub/tourist/cart/checkout` | 12 | да | linked |
| `/hub/tourist/eco-points` | 12 | да | linked |
| `/hub/tourist/loyalty` | 12 | да | linked |
| `/hub/tourist/messages` | 12 | да | linked |
| `/hub/tourist/notifications` | 12 | да | linked |
| `/hub/tourist/profile` | 12 | да | linked |
| `/hub/tourist/reviews` | 12 | да | linked |
| `/hub/tourist/support` | 12 | да | linked |
| `/hub/tourist/trips` | 12 | да | linked |
| `/hub/tourist/wishlist` | 12 | да | linked |
| `/operators/join` | 12 | да | linked |
| `/partners` | 12 | да | linked |
| `/planning` | 12 | да | linked |
| `/profile` | 12 | да | linked |
| `/trending` | 12 | да | linked |
| `/hub/admin/finance` | 13 | да | linked |
| `/hub/admin/health` | 13 | да | linked |
| `/hub/agent/bookings` | 13 | да | linked |
| `/hub/agent/clients` | 13 | да | linked |
| `/hub/agent/commissions` | 13 | да | linked |
| `/hub/agent` | 13 | да | linked |
| `/hub/agent/profile` | 13 | да | linked |
| `/hub/agent/referral` | 13 | да | linked |
| `/hub/agent/vouchers` | 13 | да | linked |
| `/hub/gear/inventory` | 13 | да | linked |
| `/hub/gear` | 13 | да | linked |
| `/hub/gear/rentals` | 13 | да | linked |
| `/hub/guide/earnings` | 13 | да | linked |
| `/hub/guide/groups` | 13 | да | linked |
| `/hub/guide` | 13 | да | linked |
| `/hub/guide/schedule` | 13 | да | linked |
| `/hub/operator/bookings` | 13 | да | linked |
| `/hub/operator/calendar` | 13 | да | linked |
| `/hub/operator/clients` | 13 | да | linked |
| `/hub/operator/completeness` | 13 | да | linked |
| `/hub/operator/finance` | 13 | да | linked |
| `/hub/operator/integrations` | 13 | да | linked |
| `/hub/operator` | 13 | да | linked |
| `/hub/operator/reports` | 13 | да | linked |
| `/hub/operator/tours/[id]` | 13 | да | linked |
| `/hub/operator/tours/new` | 13 | да | linked |
| `/hub/operator/tours` | 13 | да | linked |
| `/hub/safety` | 13 | да | linked |
| `/hub/stay/accommodations` | 13 | да | linked |
| `/hub/stay/bookings` | 13 | да | linked |
| `/hub/stay/calendar` | 13 | да | linked |
| `/hub/stay/onboarding` | 13 | да | linked |
| `/hub/stay` | 13 | да | linked |
| `/hub/tourist/bookings` | 13 | да | linked |
| `/hub/tourist/my-kamchatka` | 13 | да | linked |
| `/hub/tourist` | 13 | да | linked |
| `/hub/tourist/stays` | 13 | да | linked |
| `/hub/tourist/trips/[id]` | 13 | да | linked |
| `/hub/transfer-operator/drivers` | 13 | да | linked |
| `/hub/transfer-operator` | 13 | да | linked |
| `/hub/transfer-operator/vehicles` | 13 | да | linked |
| `/on-route` | 13 | да | linked |
| `/safety` | 13 | да | linked |
| `/gear` | 14 | да | linked |
| `/hub/stay/accommodations/[id]/photos` | 14 | да | linked |
| `/hub/stay/accommodations/[id]/rooms` | 14 | да | linked |
| `/map` | 14 | да | linked |
| `/tools/equipment` | 14 | да | linked |
| `/tools/safety` | 14 | да | linked |
| `/transfers` | 14 | да | linked |
| `/hub/operator/bookings/[id]` | 16 | да | linked |
| `/hub/operator/leads/[id]` | 16 | да | linked |
| `/hub/admin/leads/[id]` | 17 | да | linked |
| `/hub/tourist/cart` | 17 | да | linked |
| `/kuzmich` | 19 | да | linked |
| `/request` | 19 | да | linked |
| `/return` | 22 | да | linked |
| `/hub/admin/safety` | 23 | да | linked |
| `/for-operators` | 24 | да | linked |
| `/accommodations` | 28 | да | linked |
| `/ai-tools` | 28 | да | linked |
| `/planner` | 28 | да | linked |
| `/park/[slug]` | 36 | да | linked |
| `/accommodations/[id]` | 37 | да | linked |
| `/collections/[slug]` | 39 | да | linked |
| `/hub/admin/channels` | 42 | да | linked |
| `/hub/admin/settings` | 53 | да | linked |
| `/tools` | 54 | да | linked |
| `/contact` | 68 | да | linked |
| `/ai-tools/[slug]` | 69 | да | linked |
| `/marketplace` | 79 | да | linked |
| `/catalog` | 81 | да | linked |
| `/routes/[id]/[zone]` | 81 | да | linked |
| `/help` | 84 | да | linked |
| `/faq` | 92 | да | linked |
| `/operators` | 100 | да | linked |
| `/hub/fishing` | 116 | да | linked |
| `/places` | 118 | да | linked |
| `/fish` | 122 | да | linked |
| `/routes` | 125 | да | linked |
| `/hub/admin/migrations` | 127 | да | linked |
| `/places/[id]` | 134 | да | linked |
| `/hub/admin/content/accommodation-reviews` | 148 | да | linked |
| `/offline/manage` | 160 | да | linked |
| `/offline` | 161 | да | linked |
| `/places/[id]/review` | 163 | да | linked |
| `/hub/admin/users` | 164 | да | linked |
| `/hub/admin/notifications` | 170 | да | linked |
| `/legal/agent-agreement` | 178 | да | linked |
| `/blog/[slug]` | 179 | да | linked |
| `/` | 181 | да | linked |
| `/about` | 198 | да | linked |
| `/guides` | 201 | да | linked |
| `/legal/terms` | 207 | да | linked |
| `/hub/admin/analytics` | 211 | да | linked |
| `/hub/admin/guide-certifications` | 213 | да | linked |
| `/legal/offer` | 216 | да | linked |
| `/marketplace/tours/[id]` | 218 | да | linked |
| `/hub/admin/content/reviews` | 232 | да | linked |
| `/hub/admin/promo-codes` | 240 | да | linked |
| `/legal/commission` | 240 | да | linked |
| `/hub/admin/activity` | 246 | да | linked |
| `/legal/privacy` | 246 | да | linked |
| `/hub/admin/content/places-import` | 265 | да | linked |
| `/widget/[partnerId]` | 267 | да | linked |
| `/blog` | 286 | да | linked |
| `/hub/admin/knowledge` | 293 | да | linked |
| `/routes/[id]` | 316 | да | linked |
| `/fish/[id]` | 322 | да | linked |
| `/safety/incidents` | 333 | да | linked |
| `/safety/offline` | 337 | да | linked |
| `/operators/[slug]` | 451 | да | linked |
| `/sos` | 496 | да | linked |
| `/hub/admin/calendar` | 532 | да | linked |
| `/hub/admin` | 540 | да | linked |
| `/hub/admin/content/partners` | 741 | да | linked |
| `/register` | 769 | да | linked |
| `/hub/admin/content/tours` | 858 | да | linked |

---

*Машиночитаемая версия (все поля, включая топ-импортёров) — `docs/reorg-stage0-inventory.json`. Скрипт-анализатор одноразовый (scratchpad), в репозиторий не входит.*
