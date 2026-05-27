# Как пользоваться инструментами — шпаргалка

Все команды вводятся в чат с Claude Code. Начинаются с `/`.

---

## Я хочу... → используй это

### 🔍 Понять кодовую базу

| Хочу | Команда | Пример |
|------|---------|--------|
| Понять как работает модуль/файл | `/understand-explain` | `/understand-explain lib/kuzmich/core.ts` |
| Что сломается от моего изменения | `/understand-diff` | `/understand-diff` (сам смотрит git diff) |
| Экскурсия по всей платформе | `/understand` | `/understand` |
| Спросить про код на русском | `/understand-chat` | `/understand-chat как работает waterfall провайдеров?` |
| Онбординг нового разработчика | `/understand-onboard` | `/understand-onboard` |

---

### 📊 Данные и аналитика (postgres MCP)

| Хочу | Команда | Пример |
|------|---------|--------|
| Статистика бронирований | `/analyze bookings` | сколько бронирований за месяц, статусы |
| Топ маршруты и места | `/analyze routes` | view_count, coverage |
| Метрики Кузьмича | `/analyze kuzmich` | фидбек, оценки, проблемы |
| Активность операторов | `/analyze operators` | кто активен, кто завис |
| Любой вопрос к БД | `/analyze <вопрос>` | `/analyze сколько мест без описания?` |

---

### 🎧 Customer Support

| Хочу | Команда | Пример |
|------|---------|--------|
| Что беспокоит туристов сейчас | `/triage` | последние 7 дней |
| Только плохой фидбек | `/triage bad` | все жалобы с комментариями |
| Фидбек за месяц | `/triage 30d` | трендинг проблем |
| Качество ответов Кузьмича | `/triage kuzmich` | оценки accuracy/safety/helpfulness |

---

### ⚙️ Операции

| Хочу | Команда | Пример |
|------|---------|--------|
| Инструкция при падении Кузьмича | `/runbook-creation kuzmich-down` | диагностика + шаги |
| Онбординг нового оператора | `/runbook-creation operator-onboarding` | чек-лист |
| Откат деплоя | `/runbook-creation deploy-rollback` | шаги через Timeweb |
| Любой процесс | `/runbook-creation <процесс>` | `/runbook-creation guide-certification` |

---

### 💻 Разработка

| Хочу | Команда | Пример |
|------|---------|--------|
| Написать API + UI одновременно | `/parallel-dev` | `/parallel-dev фича: фильтр маршрутов по сложности` |
| Создать миграцию БД | `/migration` | `/migration добавить колонку views в places` |
| Создать cron endpoint | `/cron-job` | `/cron-job очистка старых уведомлений` |
| Сгенерировать изображение | `/image-generator` | `/image-generator вулкан Камчатки на закате` |

---

### ✅ Качество и безопасность

| Хочу | Команда | Пример |
|------|---------|--------|
| Проверить всё перед коммитом | `/preflight` | TS + тесты + SQL + auth |
| Аудит нарушений CLAUDE.md | `/audit` | найдёт SELECT *, console.log, прямые AI-вызовы |
| Ревью текущего diff | `/code-review` | `/code-review high` для глубокого ревью |
| Ревью + автофикс | `/simplify` | применит фиксы сам |
| Security review ветки | `/security-review` | проверка уязвимостей |
| Проверить что фича реально работает | `/verify` | `/verify что кнопка бронирования работает` |
| Запустить приложение | `/run` | поднимет dev-сервер и проверит |

---

### 🤖 Оптимизация AI

| Хочу | Команда | Пример |
|------|---------|--------|
| Улучшить промпт Кузьмича по реальным фейлам | `/skill-opt kuzmich` | ReflACT по feedback из БД |
| Улучшить любой скилл | `/skill-opt <имя>` | `/skill-opt audit` |

---

### 🔧 Настройка среды

| Хочу | Команда | Пример |
|------|---------|--------|
| Добавить permission / hook / переменную | `/update-config` | `/update-config разрешить curl на api.timeweb.com` |
| Настроить горячие клавиши | `/keybindings-help` | `/keybindings-help` |
| Настроить статус-строку | (спросить) | показывает model/tokens/branch |

---

## Самые частые сценарии

### Утром — что происходит
```
/triage
/analyze bookings
```

### Перед коммитом
```
/preflight
```
(или просто `git commit` — хуки проверят TS и схему БД автоматически)

### Что-то упало в проде
```
/runbook-creation kuzmich-down
/analyze kuzmich
```

### Начинаю новую фичу
```
/understand-diff        ← после планирования
/parallel-dev <фича>   ← пишет API + UI параллельно
/migration <что>        ← если нужна БД миграция
/preflight             ← перед пушем
```

### Хочу понять незнакомый файл
```
/understand-explain <путь к файлу>
```

---

## Как работает postgres MCP

В `.claude/settings.json` подключён postgres MCP-сервер. При старте сессии он автоматически соединяется с `$DATABASE_URL`.

Это значит: `/analyze`, `/triage`, `/skill-opt kuzmich` и любые SQL-запросы в чате работают напрямую с продовой БД **прямо из чата**.

Проверить подключение: введи `/mcp` — увидишь статус postgres.

---

## Что есть в проекте

```
.claude/
  HOW-TO.md          ← этот файл
  MISSION.md         ← философия продукта (читать перед UI)
  DESIGN.md          ← визуальный язык
  MEMORY.md          ← архитектурные хитрости
  settings.json      ← MCP, hooks, permissions, plugins
  commands/          ← все скиллы (markdown)
    analyze.md
    triage.md
    runbook-creation.md
    skill-opt.md
    audit.md
    preflight.md
    migration.md
    parallel-dev.md
    image-generator.md
    swiss-knife.md
    cron-job.md
    understand*.md
```

---

*Обновлено: май 2026*
