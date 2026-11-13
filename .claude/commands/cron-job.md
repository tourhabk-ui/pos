Создай новый cron endpoint по стандарту проекта.

## Аргументы

`$ARGUMENTS` — описание задачи (например: "отправка напоминаний операторам о незакрытых заявках")

## Шаг 1 — Определи параметры

Ответь на вопросы (если не указано в аргументах — предложи разумные значения):

```
ROUTE:      /api/cron/{kebab-case-name}     например /api/cron/booking-reminders
FILE:       app/api/cron/{name}/route.ts
КТО ЗОВЁТ:  расписание GitHub Actions / шаг общего получасового файла / человек по адресу
ПИШЕТ:      да / нет — меняет ли роут данные
TIMEOUT:    секунды, например 30 или 120
```

«Кто зовёт» решается до кода: роут под `/api/cron/`, который никто не зовёт и
который нигде не объявлен, красит CI (шаг 3).

## Шаг 2 — Создай файл

Образец маленького роута — `app/api/cron/route-permit-census/route.ts`
(перепись, только чтение). Логику держи в `lib/`, роут — тонкий.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = {TIMEOUT};

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await run{Name}();          // lib/{domain}/{name}.ts
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[{name}] не выполнено:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ success: false, error: 'Не выполнено' }, { status: 500 });
  }
}
```

### Правила

- **Секрет** читает `getCronSecret`: заголовок `Authorization: Bearer` или
  `?secret=`. Сравнение — `timingSafeCompare`. Своего чтения заголовков не пиши.
- **Отказ не глушится** (CLAUDE.md §4.0): в `catch` — имя проверки и SQLSTATE
  в `console.error`. Пустого `catch` нет. Отказ базы — это 500, а не пустой
  успешный ответ: пустой ответ читается как «данных нет».
- **Ноль при нулевом входе — отказ, а не успех.** Прогон, который разобрал
  0 из 41, обязан краснеть.
- **Успешный прогон пишет меру** в журнал (`logAgentRun` из
  `lib/agents/run-logger`: `items_processed` — сколько проверено,
  `items_created` — сколько создано), если роут идёт по расписанию. Сторож:
  `tests/unit/agent-runs-measured.test.ts`.
- **ПД** в ответ и в лог не идут (скилл `pd-guard`). Репозиторий публичный:
  ответ переписи виден в логах Actions всем.
- Никаких эмодзи и `console.log`.

## Шаг 3 — Объяви, кто зовёт роут

Один из трёх путей. Без объявления сторож
`tests/unit/cron-scheduler-declared.test.ts` красный.

1. **Человек по адресу** (перепись, разбор, починка) — запись в
   `lib/agents/cron-schedulers.ts`: `kind: 'manual'`, `writes`, `note`.
2. **По расписанию** — запись в `lib/agents/cron-registry.ts` и workflow в
   `.github/workflows/`. Сначала прочитай CLAUDE.md §8 о планировщике: GitHub
   душит очередь по числу файлов с расписанием. Получасовой шаг добавляй в
   `cron-safety-heartbeat.yml`, а не новым файлом. Сторожа:
   `cron-registry-honesty` (реестр и workflow совпадают) и `cron-off-peak`
   (крон, который зовёт модель, стоит вне окон пика DeepSeek).
3. **Внешний планировщик** — `kind: 'external'` в `cron-schedulers.ts`. Идёт ли
   он на деле, репозиторий подтвердить не может: проверяй по следу в данных.

## Шаг 4 — Проверка и отчёт

Прод из сессии не виден. Роут зовётся с раннера GitHub маркером
`.github/triggers/prod-check.json` (поле `urls`, свой номер `run`, причина в
`why`); ответ читается в логе прогона после выката.

```
CRON: {название}
Файл:      app/api/cron/{name}/route.ts
Route:     GET /api/cron/{name}
Кто зовёт: {manual | расписание и файл | external}
Пишет:     {да | нет}
Проверка:  {тест по вызову роута} + {прогон prod-check после выката}
```
