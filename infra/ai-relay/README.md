# AI-релей — обход гео-блокировки для флагманских моделей

> **Нужен ли тебе релей вообще?** Для СИЛЬНОГО решателя эволюции — **нет**.
> DeepSeek и Qwen достижимы из РФ напрямую, а модель выбирается **автоматически**
> из `/v1/models` провайдера (`lib/ai/model-resolver.ts`, без привязки к id) —
> провайдер выпустит новее, подхватится само. Model-watcher заведёт intel-находку
> при появлении модели сильнее текущей. Релей нужен **только если хочешь именно
> Claude/GPT** (флагманы через OpenRouter/Anthropic). Модели-id нигде не пиннятся
> руками; `EVO_DECISION_MODEL`/`EVO_DECISION_QWEN_MODEL` — необязательный override.

Прод Ведара хостится на Timeweb в РФ. `openrouter.ai` и `api.anthropic.com`
блокируют РФ-IP, поэтому флагманы **Claude/GPT** недостижимы, и waterfall
(`lib/ai/providers.ts`) для них падает на DeepSeek/Gemini. Симптом —
health-предупреждения «OpenRouter недоступен», «Anthropic недоступен».

Релей — прозрачный прокси вне РФ. Наш сервер шлёт запрос на релей, релей
форвардит его в апстрим со своего (не-РФ) IP. Ключи идут в `Authorization` от
нашего сервера, релей их не хранит.

## Вариант A — Cloudflare Worker (бесплатно, рекомендуется)

Edge Cloudflare живёт вне РФ. Файл воркера — `worker.js` рядом.

```bash
npm i -g wrangler        # или npx
cd infra/ai-relay
wrangler deploy          # создаст https://<name>.<account>.workers.dev
```

Минимальный `wrangler.toml`:

```toml
name = "vedar-ai-relay"
main = "worker.js"
compatibility_date = "2024-11-01"
```

После деплоя пропишите на Timeweb (переменные окружения приложения):

```
OPENROUTER_BASE_URL = https://vedar-ai-relay.<account>.workers.dev/or/api/v1
ANTHROPIC_BASE_URL  = https://vedar-ai-relay.<account>.workers.dev/anthropic
```

(Необязательно) защита от чужого использования: задайте секрет воркеру
(`wrangler secret put RELAY_SECRET`) — тогда воркер требует заголовок
`X-Relay-Secret`. Чтобы наш сервер его слал, добавьте отправку заголовка в
`lib/ai/providers.ts` (сейчас не требуется — апстримы захардкожены, воркер не
открытый прокси).

## Вариант B — коммерческий РФ-доступный прокси

Сервисы вроде ProxyAPI / vseGPT дают РФ-достижимый эндпоинт в формате OpenAI/
OpenRouter. Тогда воркер не нужен — просто пропишите их base URL и их ключ:

```
OPENROUTER_BASE_URL = <их OpenAI-совместимый /v1>
OPENROUTER_API_KEY  = <их ключ>
```

Минус — платите посреднику и доверяете ему трафик/ключи.

## Вариант C — свой VPS вне РФ

Nginx `proxy_pass` на `openrouter.ai` / `api.anthropic.com`, base URL → на VPS.
Больше контроля, но нужно администрировать сервер.

## Проверка

После настройки открой (с прод-домена, т.к. проверка идёт С РФ-сервера):

```
https://vedarai.ru/api/ai/relay-check?secret=<CRON_SECRET>
```

Эндпоинт даёт прямой вердикт: включён ли релей, достижимы ли openrouter.ai /
api.anthropic.com с сервера (из РФ) и проходит ли реальный флагман-вызов
(Claude через OpenRouter). Гео-блок виден как `timeout`/`network error` в
`reachable_from_server`, а не как HTTP-статус.

Ожидаемый `verdict` при исправном релее: «OK: релей включён, флагманы
достижимы». Если «НУЖЕН РЕЛЕЙ» — воркер не задеплоен или `OPENROUTER_BASE_URL`
не задан; если «РЕЛЕЙ НЕ ОТВЕЧАЕТ» — проверь URL воркера и что `wrangler deploy`
прошёл.

Дополнительно `/api/ai/debug-waterfall?secret=<CRON_SECRET>` прогоняет весь
waterfall, а в `llm_usage_log` при успехе появятся вызовы `anthropic/claude-*`,
а не только DeepSeek/Gemini.

## Как это работает в коде

`lib/ai/providers.ts` читает `OPENROUTER_BASE_URL` / `ANTHROPIC_BASE_URL` один
раз при старте (константы `OPENROUTER_BASE` / `ANTHROPIC_BASE`, дефолт — прямые
адреса). Все вызовы OpenRouter/Anthropic идут через эти константы. Переменные
не заданы → поведение ровно как раньше (прямые запросы).
