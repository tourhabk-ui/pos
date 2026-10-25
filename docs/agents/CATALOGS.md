# Каталоги агентов: где Ведар числится и что подать руками

> Снято 12.10.2026 с документации каталогов (ссылки ниже) и состояния репозитория.
> Строки «сделано» держат сторожа (`mcp-catalogs`, `agent-discovery-cards`); строки
> «за владельцем» — чек-лист, его срок годности — до следующей сверки с порталами.
> Решение владельца 12.10: «даю все права, сделай нас видимыми для всех агентов и A2A».
> Китайский контур пошагово (ModelScope, mcp.so, Coze, Baidu, Bing, ключи Kimi и GLM) — `CHINA.md` (13.10).
> Решение владельца 14.10: «пока достаточно, будем отслеживать». Новых подач нет;
> отслеживаем: внесение в ModelScope (подано 14.10, проверка 16.10), ежемесячную пробу
> знания (`model-knowledge-probe`, итог в Telegram) и журнал клиентов MCP/A2A. Отложены
> до слова владельца: статья на Хабре, расширение Gemini CLI / Qwen Code (репозиторий с
> темой `gemini-cli-extension`, галерея обходит такие раз в сутки), Bing Webmaster,
> заявка в Cline, статья по-китайски.

## Что уже стоит (из репозитория, без аккаунтов)

| Канал | Адрес | Держит |
|---|---|---|
| MCP Registry (официальный) | `ru.vedarai/mcp`, манифест `server.json`, публикация маркером `.github/triggers/mcp-registry-publish.json` | `mcp-registry-publish.test.ts` |
| Smithery | `tourhabk/vedar`, `npx -y smithery mcp add tourhabk/vedar` | `mcp-catalogs.test.ts` |
| Glama | владение подтверждено `/.well-known/glama.json`; оценка сервера — **A**, высшая (владелец, 25.10) | `lib/mcp/catalogs.ts` |
| Карточка сервера (MCP Server Card, SEP-2127) | `https://vedarai.ru/api/mcp/server-card` | `agent-discovery-cards.test.ts` |
| AI Catalog домена | `https://vedarai.ru/.well-known/ai-catalog.json` | `agent-discovery-cards.test.ts` |
| Манифест MCP | `https://vedarai.ru/.well-known/mcp.json` | `mcp-discovery.test.ts` |
| Визитки A2A | `/.well-known/agent-card.json` (1.0), `/.well-known/agent.json` (0.3) | `a2a-discovery.test.ts` |
| A2A Registry (a2aregistry.org) | запись `538d68a1-16a1-4e55-af5a-8d672b6f1ac7`, регистрация 12.10, статус при регистрации `under_review` | `lib/a2a/catalogs.ts` |
| llms.txt, robots, перепись краулеров | `/llms.txt`, `/robots.txt`, `GET /api/cron/agent-entry-census` | `agents-china-layer.test.ts` |
| Подтверждение домена для каталога ChatGPT | `/.well-known/openai-apps-challenge` отдаёт токен из `OPENAI_APPS_CHALLENGE_TOKEN` (Timeweb) | `agent-discovery-cards.test.ts` |
| OpenAPI 3.1 и каталог API (RFC 9727) — для агентов без MCP и A2A | `https://vedarai.ru/openapi.json`, `https://vedarai.ru/.well-known/api-catalog`; заголовок `Link: rel="api-catalog"` на главной | `openapi-agents.test.ts` |
| Кто приходит из ИИ — журнал A2A, клиенты MCP, семейства у визиток | `/hub/admin/a2a` (срез `GET /api/admin/analytics/a2a`, журнал `a2a_requests`, миграция 1219) | `a2a-journal-admin.test.ts` |
| Российские ИИ (13.10, «остались российские ИИ»): журнал видит клиентов РФ (метка «РФ», группа `clients_ru` в `mcp-census`), агент Яндекса с нашим MCP — проба `GET /api/cron/yandex-mcp-probe` по маркеру, нога `yandex` в пробе знания | `docs/agents/RUSSIA.md` | `ru-clients.test.ts`, `yandex-mcp-probe.test.ts` |

Не подходит по построению: Docker MCP Catalog (`docker/mcp-registry`) принимает только серверы-образы, у нас удалённый Streamable HTTP.

## За владельцем: аккаунты и порталы

Каждая строка — одна форма. Тексты и ассеты для вставки — в разделе «Материалы».

| Каталог | Где подавать | Аккаунт | Что просит | Примечание |
|---|---|---|---|---|
| Claude Connectors Directory | https://claude.ai/directory/manage → Submit new → MCP connector | любой платный план Claude | URL `https://vedarai.ru/api/mcp`; инструменты синхронизируются сами (у всех есть `title` и `readOnlyHint`/`destructiveHint`); листинг: имя ≤100, одна строка ≤200, описание ≤2000, 1–5 категорий, URL документации, URL политики, контакт поддержки, иконка, slug; семь подтверждений политики | после подачи автоскан и листинг в состоянии Community без ручного ревью (по документации 12.10). Тестовый аккаунт не нужен: авторизации нет **Не подаём (14.10, владелец засомневался — проверено):** компания российская, а Anthropic Россию не обслуживает (её нет в https://www.anthropic.com/supported-countries), и условия с 05.09.2025 запрещают пользоваться Claude организациям из неподдерживаемых стран и под их контролем. Заявка требует настоящего названия компании (ООО) — её отклонят, а под удар попадёт аккаунт. Скрывать происхождение компании нельзя. |
| ChatGPT (plugins / apps) | https://platform.openai.com/plugins → Upload new or existing plugin | верификация организации в Platform Dashboard | ZIP с манифестом плагина и MCP-сервером (`type: "none"`), подтверждение домена через `/.well-known/openai-apps-challenge` (роут готов, токен — в переменную), `displayName` ≤30, `shortDescription` ≤30, `longDescription` ≤4000, категория, четыре HTTPS-URL (сайт, поддержка, политика, условия), логотип квадратный ≥48 px, 5 положительных и 3 отрицательных тест-кейса, видео-демо, release notes | только один MCP-сервер на плагин; API-key/header-авторизация не поддерживается, у нас её и нет **Не подаём (14.10):** OpenAI Россию не обслуживает — её нет в https://developers.openai.com/api/docs/supported-countries; та же причина, что у каталога Claude. |
| GPT Actions (пользовательские GPT в ChatGPT) | https://chatgpt.com/gpts/editor → Configure → Actions → Import from URL | ChatGPT Plus/Team/Enterprise | URL схемы `https://vedarai.ru/openapi.json` (OpenAPI 3.1 JSON), Authentication: None; для публикации в GPT Store — URL политики конфиденциальности | действия зовут REST A2A и читающие эндпоинты; заявка — `POST /api/a2a/v1/message:send` с DataPart `{tool, arguments}` и `consent: true`. В инструкции GPT повторить строку для хоста из манифеста (`systemPromptHint`) **Не подаём (14.10):** та же причина, что у ChatGPT (plugins / apps). |
| Copilot Studio (Microsoft) | агент → Tools → Add a tool → REST API (OpenAPI) | лицензия Copilot Studio | тот же `openapi.json` | какую версию OpenAPI принимает импорт (3.0 или 3.1), на 12.10 не сверено — проверить при первой подаче; при отказе на 3.1 конвертировать документ в 3.0 руками (type-массивы и const) |
| PulseMCP | https://www.pulsemcp.com/submit | учётная запись | — | на 12.10 приём новых серверов приостановлен («submissions are still paused»); нас в списке нет |
| mcp.so | https://mcp.so/submit | GitHub-логин | GitHub URL, короткое описание, теги, категория | 13.10 владелец и проверка с раннера: бесплатной подачи больше нет, только 39 $ («Pay and submit automatically»); 16 тысяч серверов — ценность низкая, решение владельца |
| DeepSeek Harness — каталог коннекторов «MCP连接器» (плагин `dsh-mcp-connector`) | PR с файлом `connectors/vedar.json` в https://github.com/duhu2000/dsh-mcp-connector-registry (форк → ветка → PR) либо заявка «Connector request» через их шаблон issue | GitHub | один JSON-дескриптор (копия `integrations/dsh-mcp-connector-registry/connectors/vedar.json`): `auth.mode: none`, `streamable-http`, иконка по HTTPS, категория из девяти, примеры запросов; CI каталога гоняет схему и `assets:check` | **Подано 13.10: PR duhu2000/dsh-mcp-connector-registry#44 «Add vedar»** из форка `tourhabk-ui/dsh-mcp-connector-registry`, ветка `add-vedar` (их `npm test` 106/106 и `npm run validate` зелёные локально). 109 карточек на 06.10; пользователь DeepSeek Harness подключает нас кнопкой в интерфейсе. Сторож дескриптора — `tests/unit/dsh-integrations.test.ts` |
| DeepSeek Harness — плагин `dsh-vedar` (тема GitHub `dsh-plugin`, 19 тысяч репозиториев; каталоги тему не читают — `dshmarket` берёт плагины из реестра `awesome-dsh-plugin`, 1024Store из своего каталога, сверено 15.10; файлы подачи — `docs/agents/submissions/dsh/`) | публичный репозиторий `tourhabk-ui/dsh-vedar` с файлами из `integrations/dsh-vedar/`, тема `dsh-plugin` в About | GitHub | `package.json` с `dsh.bundle.patch`, `cordis.patch.yml` со строкой `@deepseek-ai/dsh-mcp-client`, README zh/en | **Выложен 13.10**: https://github.com/tourhabk-ui/dsh-vedar, темы `dsh-plugin`, `mcp`, `kamchatka` стоят (владелец). Установка: `dsh plugin --profile web add github:tourhabk-ui/dsh-vedar`. Строка сверена с README моста 0.2.0-rc.2; **end-to-end проверено 14.10** с раннера (`dsh-vedar-probe.yml`, прогон 2): DeepSeek позвала 17 инструментов Ведара, все без ошибки. Для установки нужен pnpm |
| LobeHub MCP Marketplace (китайская версия lobehub.com/zh) | карточка `tourhabk-ui-pos` уже создана площадкой сама; забирает её владелец репозитория через `@lobehub/market-cli` (`login` → `github connect` → `plugin claim tourhabk-ui-pos`) | GitHub-аккаунт владельца репозитория | манифест `plugin init --url https://vedarai.ru/api/mcp`; имя английское, версия выше 1.0.0 | **15.10:** карточка есть, не забрана; имя карточки площадка взяла из H1 README. Шаги — у владельца, на своём компьютере (Node ≥ 22) |
| Dify Marketplace (langgenius/dify-plugins) | PR плагина с исходником и `.difypkg` | GitHub (форк) | плагин со своими инструментами поверх эндпоинтов Ведара, PRIVACY с перечнем ПД, проверка на Dify Community Edition | **15.10:** не подавали, работа на 1–2 дня. Без плагина пользователь Dify подключает нас сам: Tools → MCP по адресу или Swagger-импорт `https://vedarai.ru/openapi.json` |
| Kimi 插件市场 (веб, Kimi Work, Kimi Code) | Plugin Builder в Kimi Work → «申请发布到官方市场» | аккаунт kimi.com (примет ли +7 — не проверено) | `server.json` реестра или репозиторий плагина | **15.10:** не подавали; сначала вход на kimi.com |
| Awesome-MCP-ZH (yzfly, 7,7 тыс. звёзд, список на китайском) | PR в https://github.com/yzfly/Awesome-MCP-ZH — строка таблицы в разделе «🌍 地理位置与出行» | GitHub | `| [Vedar（堪察加旅游）](https://github.com/tourhabk-ui/pos) | 一句话中文介绍 | 官方实现, TypeScript, 远程 Streamable HTTP, 无需认证 |`; README репозитория должен по-китайски объяснять инструменты и подключение (есть с 13.10) | **Подано 13.10: PR yzfly/Awesome-MCP-ZH#727** из форка `tourhabk-ui/Awesome-MCP-ZH`, ветка `add-vedar`. Критерии: реальный сервер, доступный удалённый адрес, ясный README, ценность для китайских пользователей; «слишком новый без следов использования» могут отложить |
| awesome-remote-mcp-servers (punkpeye; главный список на 96 тыс. звёзд отсылает удалённые серверы сюда) | PR в https://github.com/punkpeye/awesome-remote-mcp-servers — строка таблицы «Remote MCP Server List» | GitHub | `| Vedar — Kamchatka travel | Other | `https://vedarai.ru/api/mcp` | None | [Vedar](https://vedarai.ru) |` | **Стоит: заявка punkpeye/awesome-remote-mcp-servers#404 принята** (владелец, 25.10). До неё, 13.10, запись с бейджем Glama `ru.vedarai/mcp` уже была в разделе Travel & Transportation — список берёт коннекторы Glama сам |
| awesome-mcp-servers (punkpeye, главный список) | PR в https://github.com/punkpeye/awesome-mcp-servers | GitHub | сервер с открытым кодом, который ставится у себя | **Не подаём, пока нет кода (владелец, 25.10: «займусь этим потом»):** берут только устанавливаемые серверы с исходниками, а у нас открыты описание и адрес удалённого сервера. Условие подачи — исходники npm-клиента в репозитории `vedar-mcp` |
| Cline MCP Marketplace | issue в https://github.com/cline/mcp-marketplace | GitHub | ссылка на репозиторий, PNG-логотип 400×400 (`public/icons/icon-400.png`), причина добавления; `llms-install.md` не обязателен — хватает README | вначале проверить, что Cline по README сам настраивает удалённый сервер |
| Cursor Directory | https://cursor.directory/mcp | — | процесс подачи на 12.10 не найден | уточнить на самом сайте |
| ModelScope MCP 广场 (Alibaba, Qwen) | https://modelscope.cn/mcp → «创建MCP服务» | аккаунт ModelScope — вход через GitHub или телефон | запись по URL с типом `streamable_http` без кода; режим «可托管部署» требует анонимного `tools/list` (у нас есть) либо «仅分发展示»; форма обрабатывается до 3 рабочих дней | пошагово и тексты — `CHINA.md`, шаг 1 (сверено 13.10) |
| Coze / Volcano Engine (ByteDance, Doubao) | https://www.coze.cn → 资源库 → +资源 → 插件 → тип MCP | аккаунт coze.cn (телефон; примет ли номер не КНР — только на месте) | HTTPS-адрес сервера (домен, не IP), заголовки, авторизация «不需要授权»; инструменты подтягиваются сами; затем 发布 и 扣子插件商店 | пошагово — `CHINA.md`, шаг 3 (сверено 13.10 по docs.coze.cn) |
| Baidu 搜索资源平台 (вебмастер, для поиска Baidu и моделей на нём) | https://ziyuan.baidu.com → 站点管理 → 添加网站 | аккаунт Baidu (телефон) | верификация HTML-тегом `baidu-site-verification` (тег ставится из репозитория), sitemap, push-токен 普通收录; индексация 4–8 недель | `CHINA.md`, шаг 4. Каталог MCP у Baidu — MCP World (www.mcpworld.com/mcp-submit): обязательное поле «联系电话» принимает только номер КНР (сверено по коду формы 15.10) — не подаём, пока нет номера китайского партнёра с его согласия; чужой или выдуманный номер вписывать нельзя |
| Bing Webmaster (Bing работает в КНР) | https://www.bing.com/webmasters | аккаунт Microsoft | верификация тегом `msvalidate.01` или импорт из Google Search Console; sitemap; IndexNow уже стоит | **15.10:** аккаунт заведён, тег `msvalidate.01` стоит (`lib/seo/site-verification.ts`); сайт добавлять адресом `https://vedarai.ru/`, не `/api/mcp`. `CHINA.md`, шаг 5. Tencent: MCP 广场 прямо отказывает сторонним, CloudBase MCP 市场 берёт только Stdio-образы в своём облаке (разведка 15.10) — не подаём |
| a2a-registry.org (другой реестр) | https://www.a2a-registry.org | DNS- или GitHub-верификация | — | не путать с a2aregistry.org, где мы уже есть |
| Yandex AI Studio — MCP Hub (внешний MCP-сервер для ваших агентов; публичного каталога MCP у Яндекса нет) | AI Studio → Agent Atelier → MCP-серверы → Создать → Внешний MCP-сервер | аккаунт Yandex Cloud с ролями `serverless.mcpGateways.editor`, `iam.serviceAccounts.user` | имя `vedar`, URL `https://vedarai.ru/api/mcp`, Streamable HTTP, «Без авторизации», выбрать инструменты (20 из лимита 50) | пошагово — `RUSSIA.md`, шаг 2. Проба с прода (`yandex-mcp-probe`) идёт и без этого — через Responses API с `server_url` |
| GigaChat (Сбер) | каталога нет: подключение MCP только кодом разработчика (GigaChain, `langchain-mcp-adapters`) | — | — | `RUSSIA.md`, шаг 3: отдельная обёртка и ключ GigaChat — по решению владельца; мост не подходит |

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

Vedar is the travel platform for Kamchatka, Russia. The MCP server gives agents the platform's own data: operator tours with real seat availability by date, safety status of the region and of specific places (seismic and volcanic activity, weather warnings, official alerts), places and routes with hazards and registration requirements, weather forecasts, stays, gear rental, transfers, and day-by-day trip plans. Twenty tools: sixteen read-only, and four requests that a human confirms — a tour-selection lead, a booking request for a specific tour and date (availability is checked first), a charter request for a whole vehicle, and a stay request to a host. Each request needs the traveller's explicit consent. Nothing is booked or paid instantly: the operator or host confirms, and payment is settled directly with them. Data is in Russian; tool parameters work best in Russian or English. Emergency number in Kamchatka: 112.

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
