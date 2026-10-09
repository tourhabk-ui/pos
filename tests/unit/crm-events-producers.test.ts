/**
 * Сторож: у каждой смены состояния источника есть событие в ленте клиента
 * (CRM #2325, шаг 1б; правило 10.09 «объявленный исход без источника»).
 *
 * Лента обещает партнёру историю клиента. Обещание держится не таблицей, а
 * производителями: каждое место, где код меняет статус брони, заявки или
 * клиента агента, обязано записать событие (`recordSourceEventQuietly`), а
 * каждое место, где пишется сообщение чата, — его факт
 * (`recordChatMessageQuietly`). Дверь без события — пустая строка в ленте там,
 * где у клиента что-то произошло, и агент 1д сделает из пустоты вывод
 * «с клиентом ничего не было».
 *
 * Писатели находятся ПО КОДУ: `UPDATE <таблица> SET ... status =` (или
 * динамический `SET ${...}`) в шести таблицах-источниках. Файл с таким
 * UPDATE обязан импортировать `@/lib/crm/events` — либо стоять в
 * `KNOWN_WITHOUT_EVENT` с причиной. Список самоустаревающий: писатель пропал
 * или обзавёлся событием — запись требует убрать.
 *
 * Статика здесь лишь перечисляет употребления (CLAUDE.md §4, случай 24.08):
 * она не судит, ВЫПОЛНЯЕТСЯ ли запрос, — для этого есть интеграционный тест
 * `tests/integration/crm-contacts.pg.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Таблица источника → колонка состояния. */
const STATE_COLUMN: Readonly<Record<string, string>> = {
  operator_bookings: 'booking_status',
  accommodation_bookings: 'status',
  gear_rentals: 'status',
  transfer_seat_bookings: 'status',
  leads: 'status',
  agent_clients: 'status',
};

type Known =
  | { reason: string }
  /** SQL-константа: выполняет её другой файл, и событие — у исполнителя. */
  | { reason: string; executor: string };

const KNOWN_WITHOUT_EVENT: Readonly<Record<string, Known>> = {
  'app/api/payments/webhook/route.ts': {
    reason: 'приёмник оплаты (§7 НЕ ТРОГАТЬ); приём оплаты выключен 05.10 — событие «оплачена» заводится вместе с включением, словом владельца',
  },
  'app/api/hub/operator/payments/webhook/route.ts': {
    reason: 'приёмник оплаты (§7 НЕ ТРОГАТЬ); см. app/api/payments/webhook',
  },
  'app/api/payments/tochka/webhook/route.ts': {
    reason: 'приёмник оплаты СБП (§7 НЕ ТРОГАТЬ); см. app/api/payments/webhook',
  },
  'app/api/cron/sql-shape-check/route.ts': {
    reason: 'только PREPARE: вывод типов на разборе, ни одна строка не меняется',
  },
  'lib/services/tours/booking.service.ts': {
    reason: 'мёртвая дверь: bookingService не зовёт никто (держит crm-source-hooks)',
  },
  'lib/stay/booking-status-sql.ts': {
    reason: 'SQL-константа смены статуса брони жилья; выполняет роут владельца',
    executor: 'app/api/stay/bookings/[id]/route.ts',
  },
};

const EVENTS_IMPORT_RE = /from '@\/lib\/crm\/events'/;
const CHAT_HOOK_RE = /\brecordChatMessageQuietly\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [abs] : [];
  });
}

const FILES = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
  .map((abs) => ({ rel: relative(ROOT, abs), src: readFileSync(abs, 'utf8') }));

/** Какие таблицы-источники файл переводит в другое состояние. */
export function stateWriters(src: string): string[] {
  const out = new Set<string>();
  for (const [table, column] of Object.entries(STATE_COLUMN)) {
    const re = new RegExp(String.raw`UPDATE\s+(?:public\.)?${table}\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|\x60)`, 'g');
    for (const m of src.matchAll(re)) {
      const setClause = m[1];
      if (new RegExp(String.raw`\b${column}\s*=`).test(setClause) || /\$\{/.test(setClause)) out.add(table);
    }
  }
  return [...out].sort();
}

describe('CRM: каждая смена состояния источника пишет событие в ленту', () => {
  const writers = FILES.filter((f) => stateWriters(f.src).length > 0);

  it('писатели состояния найдены (ноль — сломан поиск, а не чистый код)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(20);
  });

  it('файл с UPDATE состояния импортирует @/lib/crm/events или объяснён в KNOWN_WITHOUT_EVENT', () => {
    const silent = writers
      .filter((f) => !EVENTS_IMPORT_RE.test(f.src) && !(f.rel in KNOWN_WITHOUT_EVENT))
      .map((f) => `${f.rel} → ${stateWriters(f.src).join(', ')}`);
    expect(silent, 'смена состояния без события в ленте — добавить recordSourceEventQuietly или причину').toEqual([]);
  });

  it('KNOWN_WITHOUT_EVENT самоустаревает: запись только у живого писателя без события', () => {
    for (const [rel, known] of Object.entries(KNOWN_WITHOUT_EVENT)) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f, `${rel}: файла нет — убрать запись`).toBeDefined();
      expect(stateWriters(f!.src).length, `${rel}: UPDATE состояния пропал — убрать запись`).toBeGreaterThan(0);
      expect(EVENTS_IMPORT_RE.test(f!.src), `${rel}: событие появилось — убрать запись`).toBe(false);
      expect(known.reason.length).toBeGreaterThan(20);
      if ('executor' in known) {
        const ex = FILES.find((x) => x.rel === known.executor);
        expect(ex, `${rel}: исполнитель ${known.executor} не найден`).toBeDefined();
        expect(EVENTS_IMPORT_RE.test(ex!.src), `${known.executor}: исполнитель константы без события`).toBe(true);
      }
    }
  });

  it('приёмники оплаты в списке — ровно те, что держит §7 (commission-all-receivers)', () => {
    const receivers = Object.keys(KNOWN_WITHOUT_EVENT).filter((k) => /payments\/.*webhook/.test(k)).sort();
    expect(receivers).toEqual([
      'app/api/hub/operator/payments/webhook/route.ts',
      'app/api/payments/tochka/webhook/route.ts',
      'app/api/payments/webhook/route.ts',
    ]);
  });
});

describe('CRM: сообщение чата оставляет факт в ленте', () => {
  const inserters = FILES.filter((f) => /INSERT\s+INTO\s+(?:public\.)?conversation_messages\b/.test(f.src));

  it('писатель сообщений найден', () => {
    expect(inserters.map((f) => f.rel)).toContain('lib/services/operators/chat.service.ts');
  });

  it('каждый INSERT в conversation_messages зовёт recordChatMessageQuietly', () => {
    const silent = inserters.filter((f) => !CHAT_HOOK_RE.test(f.src)).map((f) => f.rel);
    expect(silent, 'сообщение без факта в ленте').toEqual([]);
  });

  it('писатель события чата не копирует текст: в payload только conversation_id', () => {
    const src = readFileSync(join(ROOT, 'lib/crm/chat-events.ts'), 'utf8');
    expect(src).toMatch(/payload: \{ conversation_id: conversationId \}/);
    expect(src).not.toMatch(/\bcontent\b/);
  });
});
