# Каталоги агентов: где Ведар числится и что подать руками

> Снято 12.10.2026 с документации каталогов (ссылки ниже) и состояния репозитория.
> Строки «сделано» держат сторожа (`mcp-catalogs`, `agent-discovery-cards`); строки
> «за владельцем» — чек-лист, его срок годности — до следующей сверки с порталами.
> Решение владельца 12.10: «даю все права, сделай нас видимыми для всех агентов и A2A».

## Что уже стоит (из репозитория, без аккаунтов)

| Канал | Адрес | Держит |
|---|---|---|
| MCP Registry (официальный) | `ru.vedarai/mcp`, манифест `server.json`, публикация маркером `.github/triggers/mcp-registry-publish.json` | `mcp-registry-publish.test.ts` |
| Smithery | `tourhabk/vedar`, `npx -y smithery mcp add tourhabk/vedar` | `mcp-catalogs.test.ts` |
| Glama | владение подтверждено `/.well-known/glama.json` | `lib/mcp/catalogs.ts` |
| Карточка сервера (MCP Server Card, SEP-2127) | `https://vedarai.ru/api/mcp/server-card` | `agent-discovery-cards.test.ts` |
| AI Catalog домена | `https://vedarai.ru/.well-known/ai-catalog.json` | `agent-discovery-cards.test.ts` |
| Манифест MCP | `https://vedarai.ru/.well-known/mcp.json` | `mcp-discovery.test.ts` |
| Визитки A2A | `/.well-known/agent-card.json` (1.0), `/.well-known/agent.json` (0.3) | `a2a-discovery.test.ts` |
| A2A Registry (a2aregistry.org) | запись `538d68a1-16a1-4e55-af5a-8d672b6f1ac7`, регистрация 12.10, статус при регистрации `under_review` | `lib/a2a/catalogs.ts` |
| llms.txt, robots, перепись краулеров | `/llms.txt`, `/robots.txt`, `GET /api/cron/agent-entry-census` | `agents-china-layer.test.ts` |
| Подтверждение домена для каталога ChatGPT | `/.well-known/openai-apps-challenge` отдаёт токен из `OPENAI_APPS_CHALLENGE_TOKEN` (Timeweb) | `agent-discovery-cards.test.ts` |
| OpenAPI 3.1 и каталог API (RFC 9727) — для агентов без MCP и A2A | `https://vedarai.ru/openapi.json`, `https://vedarai.ru/.well-known/api-catalog`; заголовок `Link: rel="api-catalog"` на главной | `openapi-agents.test.ts` |
| Кто приходит из ИИ — журнал A2A, клиенты MCP, семейства у визиток | `/hub/admin/a2a` (срез `GET /api/admin/analytics/a2a`, журнал `a2a_requests`, миграция 1219) | `a2a-journal-admin.test.ts` |

Не подходит по построению: Docker MCP Catalog (`docker/mcp-registry`) принимает только серверы-образы, у нас удалённый Streamable HTTP.

## За владельцем: аккаунты и порталы

Каждая строка — одна форма. Тексты и ассеты для вставки — в разделе «Материалы».

| Каталог | Где подавать | Аккаунт | Что просит | Примечание |
|---|---|---|---|---|
| Claude Connectors Directory | https://claude.ai/directory/manage → Submit new → MCP connector | любой платный план Claude | URL `https://vedarai.ru/api/mcp`; инструменты синхронизируются сами (у всех есть `title` и `readOnlyHint`/`destructiveHint`); листинг: имя ≤100, одна строка ≤200, описание ≤2000, 1–5 категорий, URL документации, URL политики, контакт поддержки, иконка, slug; семь подтверждений политики | после подачи автоскан и листинг в состоянии Community без ручного ревью (по документации 12.10). Тестовый аккаунт не нужен: авторизации нет |
| ChatGPT (plugins / apps) | https://platform.openai.com/plugins → Upload new or existing plugin | верификация организации в Platform Dashboard | ZIP с манифестом плагина и MCP-сервером (`type: "none"`), подтверждение домена через `/.well-known/openai-apps-challenge` (роут готов, токен — в переменную), `displayName` ≤30, `shortDescription` ≤30, `longDescription` ≤4000, категория, четыре HTTPS-URL (сайт, поддержка, политика, условия), логотип квадратный ≥48 px, 5 положительных и 3 отрицательных тест-кейса, видео-демо, release notes | только один MCP-сервер на плагин; API-key/header-авторизация не поддерживается, у нас её и нет |
| GPT Actions (пользовательские GPT в ChatGPT) | https://chatgpt.com/gpts/editor → Configure → Actions → Import from URL | ChatGPT Plus/Team/Enterprise | URL схемы `https://vedarai.ru/openapi.json` (OpenAPI 3.1 JSON), Authentication: None; для публикации в GPT Store — URL политики конфиденциальности | действия зовут REST A2A и читающие эндпоинты; заявка — `POST /api/a2a/v1/message:send` с DataPart `{tool, arguments}` и `consent: true`. В инструкции GPT повторить строку для хоста из манифеста (`systemPromptHint`) |
| Copilot Studio (Microsoft) | агент → Tools → Add a tool → REST API (OpenAPI) | лицензия Copilot Studio | тот же `openapi.json` | какую версию OpenAPI принимает импорт (3.0 или 3.1), на 12.10 не сверено — проверить при первой подаче; при отказе на 3.1 конвертировать документ в 3.0 руками (type-массивы и const) |
| PulseMCP | https://www.pulsemcp.com/submit | учётная запись | — | на 12.10 приём новых серверов приостановлен («submissions are still paused»); нас в списке нет |
| mcp.so | https://mcp.so/submit | GitHub-логин | GitHub URL, короткое описание, теги, категория | индексация около суток (по сторонним описаниям) |
| Cline MCP Marketplace | issue в https://github.com/cline/mcp-marketplace | GitHub | ссылка на репозиторий, PNG-логотип 400×400 (`public/icons/icon-400.png`), причина добавления; `llms-install.md` не обязателен — хватает README | вначале проверить, что Cline по README сам настраивает удалённый сервер |
| Cursor Directory | https://cursor.directory/mcp | — | процесс подачи на 12.10 не найден | уточнить на самом сайте |
| ModelScope MCP 广场 (Alibaba, Qwen) | https://modelscope.cn/mcp | аккаунт ModelScope (китайский контур) | официального описания процесса для удалённого URL на 12.10 не найдено | проверить в консоли: «创建 MCP 服务», есть ли вариант с внешним URL |
| Coze / Volcano Engine (ByteDance, Doubao) | https://www.coze.cn | аккаунт КНР | процесс на 12.10 не найден | плагин-обёртка над MCP |
| 百度千帆 (Baidu) | https://qianfan.cloud.baidu.com | аккаунт КНР | процесс на 12.10 не найден | |
| Tencent Cloud MCP | https://cloud.tencent.com | аккаунт КНР | процесс на 12.10 не найден | |
| a2a-registry.org (другой реестр) | https://www.a2a-registry.org | DNS- или GitHub-верификация | — | не путать с a2aregistry.org, где мы уже есть |

## Материалы для форм

Все тексты — из `server.json`, `lib/mcp/public-tools.ts` (английский слой) и `lib/mcp/zh-layer.ts`; править здесь без правки источников нельзя.

### Имя и адреса

- Имя: **Vedar — Kamchatka travel** (`ru.vedarai/mcp`, ключ сервера `vedar`)
- Эндпоинт: `https://vedarai.ru/api/mcp` (Streamable HTTP, без авторизации)
- Документация: `https://vedarai.ru/mcp` · для LLM: `https://vedarai.ru/llms.txt`
- Политика: `https://vedarai.ru/legal/privacy` · условия: `https://vedarai.ru/legal/terms` · поддержка: `https://vedarai.ru/contact`
- Иконки: `public/icons/icon-512.png` (512×512), `public/icons/icon-400.png` (400×400, для Cline)
- Репозиторий: `https://github.com/tourhabk-ui/pos`

### Одна строка (≤200, из `server.json`)

Kamchatka travel: live tours and availability, safety alerts, places, weather, stays, trip plans

### Короткое описание ≤30 (ChatGPT `shortDescription`)

Kamchatka tours and safety

### Описание (≤2000)

Vedar is the travel platform for Kamchatka, Russia. The MCP server gives agents the platform's own data: operator tours with real seat availability by date, safety status of the region and of specific places (seismic and volcanic activity, weather warnings, official alerts), places and routes with hazards and registration requirements, weather forecasts, stays, gear rental, transfers, and day-by-day trip plans. Nineteen tools: fifteen read-only, and four requests that a human confirms — a tour-selection lead, a booking request for a specific tour and date (availability is checked first), a charter request for a whole vehicle, and a stay request to a host. Each request needs the traveller's explicit consent. Nothing is booked or paid instantly: the operator or host confirms, and payment is settled directly with them. Data is in Russian; tool parameters work best in Russian or English. Emergency number in Kamchatka: 112.

### Категории и теги

- Категории: Travel; Local data / Regional information; Safety
- Теги: kamchatka, travel, tours, safety, volcanoes, weather, stays, trip-planning, a2a, russia

### Примеры запросов (положительные тест-кейсы)

1. «Which Kamchatka tours have free seats on 15 August for two people?» → `get_tours`, `get_tour_availability`
2. «Is it safe to hike Gorely volcano this weekend?» → `get_guardian_context`, `safety_status`
3. «What is the weather forecast for Mutnovsky for the next three days?» → `get_weather`
4. «Plan five days in Kamchatka in August: volcanoes and bears, two adults» → `make_trip_plan`
5. «Find a guesthouse in Paratunka under 8000 RUB per night» → `search_accommodations`

### Отрицательные тест-кейсы

1. «Book and pay for the tour right now» — инструмент заявки отвечает, что подтверждает человек и оплаты через агента нет
2. «What are the operator's phone and email?» — контактов в ответах нет, только ссылка на карточку
3. «Create a booking request without the traveller's consent» — отказ: нужен `consent: true`

### Дисклеймер для листинга

Requests (lead, booking, charter, stay) are human-confirmed: the operator or host confirms and payment is settled directly with them. No instant booking or payment through the agent. Safety information is advisory; in an emergency call 112.

### Текст issue для Cline

Title: Add Vedar — Kamchatka travel (remote Streamable HTTP server)

Repository: https://github.com/tourhabk-ui/pos (server: https://vedarai.ru/api/mcp, no auth). Logo: 400×400 PNG attached (`public/icons/icon-400.png`). Why: the only MCP source of live Kamchatka tour availability and official safety status; 19 tools, 15 read-only, 4 human-confirmed requests; setup is one line (`{"url": "https://vedarai.ru/api/mcp"}`), README covers it.
