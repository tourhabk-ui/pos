# TourHab / Ведар — Knowledge Work Context

Этот файл предоставляет контекст платформы для плагинов knowledge-work-plugins (Data, Operations, Customer Support).

## Бизнес

Туристическая платформа для Камчатки (vedarai.ru). B2C бронирование туров + AI-ассистент Кузьмич.
Codename: Ведар / TourHab / Volcano OS.

## База данных (PostgreSQL)

### Ключевые таблицы

| Таблица | Записей | Описание |
|---------|---------|----------|
| `places` | 778 | Географические точки (вулканы, озёра, источники, мысы) |
| `kamchatka_routes` | 294 | Туристические маршруты с треками и описаниями |
| `operator_tours` | ~20 | Коммерческие туры от операторов |
| `operator_bookings` | — | Бронирования туристов |
| `tourist_profiles` | — | Профили зарегистрированных туристов |
| `partners` | 125 | Операторы (13) + гиды (112) |
| `ai_actions_log` | — | Фидбек и события AI (action_type: agent_feedback) |
| `agent_knowledge` | — | Знания агентов (outcomes, kuzmich_review) |

### Важные правила запросов

- Маршруты для публичных endpoints: `FROM v_kamchatka_routes_api` (не напрямую kamchatka_routes)
- Бронирования: `FROM operator_bookings` (колонка booking_status, не status)
- Туры: `FROM operator_tours`
- Фото точек: JOIN `ai_route_images` ON `route_id = places.ark_id`
- Безопасность точек: JOIN `location_safety_profile` ON `agent_route_id = places.ark_id`

## Терминология для Operations

- **operators** = туристические компании (партнёры), таблица `partners` WHERE role='operator'
- **guides** = сертифицированные гиды, таблица `partners` WHERE role='guide' + `guide_certifications`
- **tours** = коммерческие туры, таблица `operator_tours`
- **bookings** = бронирования, таблица `operator_bookings`
- **places** = географические точки (вулканы, озёра и т.д.)
- **routes** = туристические маршруты

## Customer Support каналы

- **Kuzmich Web** — виджет и страница /kuzmich (API: /api/ai/chat)
- **Kuzmich Telegram** — @KuzmichKam_bot
- **Фидбек** — хранится в `ai_actions_log` (action_type='agent_feedback', metadata: {rating, intent, comment})
- **Оценки ответов** — `agent_knowledge` (type='outcome', slug='outcome_kuzmich_*', grade: good/acceptable/needs_review)

## AI Stack

- Provider waterfall: OpenRouter → DeepSeek → Gemini → MiMo → GLM → NVIDIA → YandexGPT → MiniMax → Anthropic
- Slash-команды: /маршруты /места /туры /операторы /sos /помощь
- Промпты: `lib/ai/prompts.ts` (TOURIST_PROMPT, KUZMICH_PROMPT)

## Деплой

Push в `tourhabk-ui/pos main` → Timeweb Cloud (Fair Polydeuces) → автодеплой.
