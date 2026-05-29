---
name: runbook-creation
description: "Создать runbook (инструкцию) для операционных процессов: онбординг операторов, инциденты, деплой, аварии Кузьмича."
---

# /runbook-creation — Создание операционных runbook

Создаёт структурированные инструкции для повторяющихся процессов платформы TourHab.

## Использование

```
/runbook-creation operator-onboarding   — онбординг нового оператора
/runbook-creation kuzmich-down          — Кузьмич недоступен
/runbook-creation booking-incident      — инцидент с бронированием
/runbook-creation deploy-rollback       — откат деплоя
/runbook-creation guide-certification   — сертификация гида
/runbook-creation <процесс>             — любой другой процесс
```

---

## Алгоритм

### Шаг 1 — Определить процесс

По ARGUMENTS выбери тип runbook:
- `operator-onboarding` → регистрация, проверка документов, активация в системе
- `kuzmich-down` → диагностика провайдеров, перезапуск, fallback
- `booking-incident` → застрявшее бронирование, возврат, конфликт
- `deploy-rollback` → откат на предыдущую версию Timeweb
- `guide-certification` → загрузка сертификатов, проверка, активация
- Свободный процесс → задай уточняющий вопрос о контексте

### Шаг 2 — Собрать контекст (если нужно)

Для некоторых runbook запроси данные из БД:

**Операторы:**
```sql
SELECT id, name, email, status, created_at
FROM partners
WHERE role = 'operator'
ORDER BY created_at DESC
LIMIT 5;
```

**Бронирования в проблемном статусе:**
```sql
SELECT booking_status, COUNT(*) AS cnt
FROM operator_bookings
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY booking_status
ORDER BY cnt DESC;
```

### Шаг 3 — Создать runbook

Создай файл `docs/runbooks/{process-name}.md` со структурой:

```markdown
# Runbook: [Название процесса]

**Триггер:** Когда использовать этот runbook
**Владелец:** Кто отвечает
**Время выполнения:** ~X минут
**Последнее обновление:** [дата]

---

## Предусловия

- [ ] Доступ к [система]
- [ ] Роль [роль] в платформе

## Шаги

### 1. [Название шага]
**Что делать:**
[описание]

**Команды:**
```bash
# команды если есть
```

**Ожидаемый результат:** ...

**Если что-то пошло не так:** → перейди к разделу "Troubleshooting"

### 2. ...

## Проверка (Definition of Done)
- [ ] [критерий 1]
- [ ] [критерий 2]

## Troubleshooting

| Симптом | Причина | Решение |
|---------|---------|---------|
| ...     | ...     | ...     |

## Контакты
- Telegram: @[handle]
- Escalation: [кому]
```

---

## Готовые шаблоны

### kuzmich-down

**Диагностика:**
1. Проверь логи Timeweb → `/api/cron/health`
2. Проверь переменные окружения: `OR_API_KEY`, `OPENROUTER_API_KEY`
3. Проверь баланс OpenRouter: https://openrouter.ai/settings/credits
4. Fallback цепочка: OpenRouter → DeepSeek → Gemini → MiMo → GLM → NVIDIA → YandexGPT → Anthropic

**Быстрый фикс:**
- Нет баланса: пополнить OpenRouter
- Нет ключа: добавить `OR_API_KEY` в Timeweb Fair Polydeuces → переменные окружения
- Провайдер упал: через 5-15 минут автоматически переключится на следующий

### deploy-rollback

**Timeweb откат:**
1. Timeweb Cloud → Fair Polydeuces → Деплои
2. Найди последний стабильный деплой
3. Кнопка "Откатить"
4. Дождаться завершения (~3-5 мин)
5. Проверить `/api/health` и `/api/ai/chat`

### operator-onboarding

1. Партнёр регистрируется → `POST /api/partners/register`
2. Документы загружаются → `partner_documents`
3. Модерация → `/hub/admin/partners`
4. Активация → обновить `partners.status = 'active'`
5. Уведомление в Telegram оператору
