# vedar-mcp-bridge — любой LLM с OpenAI-совместимым API ходит в Ведар

Скрипт владельца (13.10.2026): DeepSeek, Qwen, Kimi, Doubao, GLM и любой другой
провайдер с `chat/completions` и function calling получают 20 инструментов MCP-сервера
Ведара без MCP-клиента. Ноль зависимостей, только стандартная библиотека Python 3.

```bash
export LLM_API_KEY=sk-...            # ключ провайдера
export LLM_PROVIDER=deepseek         # deepseek | qwen | moonshot | doubao | glm
export LLM_MODEL=deepseek-v4-flash   # у пресетов есть умолчание; у Doubao — endpoint-id
python3 vedar_mcp_bridge.py "八月去堪察加，哪里能看到棕熊？现在那里安全吗？"
python3 vedar_mcp_bridge.py          # интерактив
python3 vedar_mcp_bridge.py --doctor # ключ, base_url, модель, доступность MCP; на отказ — список моделей ключа
python3 vedar_mcp_bridge.py --tools  # список инструментов
python3 vedar_mcp_bridge.py --schema vedar_tools.json   # снимок схемы в формате OpenAI (для импорта в конструкторы)
```

Любой другой провайдер: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`. Ключ DashScope
привязан к контуру: китайский `dashscope.aliyuncs.com`, международный
`dashscope-intl.aliyuncs.com` — задаётся `LLM_BASE_URL`.

Что мост держит сам:
- четыре пишущих инструмента (`create_lead`, `create_booking_request`, `create_stay_request`,
  `request_charter`) не уходят без `consent: true` от человека в этом диалоге;
- системная подсказка: данные только из инструментов, безопасность перед советом, ответ на
  языке вопроса, заявка — не бронь, экстренный вызов 112;
- в журнал Ведара мост представляется `vedar-mcp-bridge/<провайдер>` — в `/hub/admin/mcp`
  видно, какая модель за ним стоит.

`--serve 8080` поднимает `POST /chat` без авторизации — только для локальной машины или
за своим прокси.

Снимок `vedar_tools.json` — 20 инструментов в формате OpenAI function; сторож
`tests/unit/vedar-mcp-bridge.test.ts` держит его имена равными живым публичным
инструментам сервера, а ворота согласия — четырём пишущим.

Живой прогон с китайскими моделями — `.github/workflows/china-bridge-probe.yml` по
маркеру `.github/triggers/china-bridge-probe.json`: с раннера, ключи DeepSeek и DashScope
из секретов репозитория, вопрос по-китайски, в сводке прогона — вызовы инструментов и
ответ.
