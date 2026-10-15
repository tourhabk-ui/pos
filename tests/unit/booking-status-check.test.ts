/**
 * Словарь статусов брони и CHECK в базе не расходятся (аудит 15.10,
 * BOOKING-CHECK; A11, п. 1.9 дорожной карты).
 *
 * У `operator_bookings.booking_status` CHECK не было, и словарей было два,
 * расходившихся между собой. Словарь сведён в один (`BOOKING_STATUSES`,
 * lib/types/statuses.ts), миграция operator_bookings_status_check поставила
 * CHECK по нему. Теперь у одного правила два места записи — код и база, — и
 * сторож держит связку:
 *
 *  - множество значений CHECK из ПОСЛЕДНЕГО по порядку применения
 *    определения (baseline, затем миграции) равно словарю. Слово в словаре
 *    без миграции — красный (писатель получит 23514 на проде); слово в CHECK
 *    без словаря — тоже красный (база пускает то, чего не знает код);
 *  - ограничение не оставлено NOT VALID;
 *  - писатель, который принимал слово вне словаря (`pending` в
 *    PUT /api/operator/bookings/[id]), пишет словарное — проверено вызовом.
 *
 * Что сервер на самом деле отклоняет, проверяет настоящий PostgreSQL:
 * tests/integration/booking-writers.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { BOOKING_STATUSES } from '@/lib/types/statuses';
import { sortMigrations } from '@/lib/database/migration-order';

const ROOT = process.cwd();
const CONSTRAINT = 'operator_bookings_booking_status_check';
const BASELINE = 'lib/database/baseline/schema-baseline.sql';

// ── Разбор определения CHECK из артефактов схемы ────────────────────────────

/** Строчные комментарии `--` вне строковых литералов. */
function stripLineComments(sql: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (inQuote) {
      out += c;
      if (c === "'") inQuote = false;
      continue;
    }
    if (c === "'") { inQuote = true; out += c; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/** Выражение в скобках, начиная с открывающей скобки `open` (кавычки учтены). */
function balanced(sql: string, open: number): string {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i]!;
    if (inQuote) { if (c === "'") inQuote = false; continue; }
    if (c === "'") { inQuote = true; continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return sql.slice(open + 1, i); }
  }
  throw new Error(`незакрытая скобка в определении ${CONSTRAINT}`);
}

interface CheckState {
  values: string[];
  validated: boolean;
  /** Где определено — для сообщения о расхождении. */
  file: string;
}

type CheckEvent =
  | { at: number; kind: 'add'; values: string[]; validated: boolean }
  | { at: number; kind: 'drop' }
  | { at: number; kind: 'validate' };

/** Значения из выражения проверки: `booking_status IN ('a', ...)` или вид pg_dump `= ANY (ARRAY['a'::…])`. */
function checkValues(expr: string, file: string): string[] {
  if (!/\bbooking_status\b[\s\S]*\b(IN|ANY)\b/i.test(expr)) {
    throw new Error(`${file}: ${CONSTRAINT} — не проверка принадлежности booking_status списку: ${expr}`);
  }
  return [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

function eventsIn(sql: string, file: string): CheckEvent[] {
  const src = stripLineComments(sql);
  const events: CheckEvent[] = [];
  const add = new RegExp(`CONSTRAINT\\s+${CONSTRAINT}\\s+CHECK\\s*\\(`, 'gi');
  for (const m of src.matchAll(add)) {
    const open = m.index! + m[0].length - 1;
    const expr = balanced(src, open);
    const after = src.slice(open + expr.length + 2);
    events.push({ at: m.index!, kind: 'add', values: checkValues(expr, file), validated: !/^\s*NOT\s+VALID\b/i.test(after) });
  }
  for (const m of src.matchAll(new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?${CONSTRAINT}\\b`, 'gi'))) {
    events.push({ at: m.index!, kind: 'drop' });
  }
  for (const m of src.matchAll(new RegExp(`VALIDATE\\s+CONSTRAINT\\s+${CONSTRAINT}\\b`, 'gi'))) {
    events.push({ at: m.index!, kind: 'validate' });
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Состояние ограничения после baseline и всех миграций в порядке применения. */
function latestCheck(): CheckState | null {
  const migrations = sortMigrations(readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')))
    .map((f) => `migrations/${f}`);
  let state: CheckState | null = null;
  for (const file of [BASELINE, ...migrations]) {
    for (const e of eventsIn(readFileSync(join(ROOT, file), 'utf-8'), file)) {
      if (e.kind === 'add') state = { values: e.values, validated: e.validated, file };
      else if (e.kind === 'drop') state = null;
      else if (state) state = { ...state, validated: true };
    }
  }
  return state;
}

describe('CHECK operator_bookings.booking_status и словарь BOOKING_STATUSES', () => {
  const state = latestCheck();

  it('ограничение определено и не снято последующей миграцией', () => {
    expect(state, `${CONSTRAINT} нет ни в baseline, ни в миграциях — или последняя его снимает`).not.toBeNull();
  });

  it('множество значений CHECK равно словарю — ни слова сверх, ни слова мимо', () => {
    const inCheck = [...new Set(state!.values)].sort();
    const inDictionary = [...new Set<string>(BOOKING_STATUSES)].sort();
    expect(
      inCheck,
      `CHECK (${state!.file}) и BOOKING_STATUSES разошлись: новое слово в словарь — только вместе с миграцией, переставляющей ${CONSTRAINT}`,
    ).toEqual(inDictionary);
  });

  it('ограничение проверено (VALIDATE), а не оставлено NOT VALID', () => {
    expect(state!.validated, `${CONSTRAINT} в ${state!.file} поставлено NOT VALID без последующего VALIDATE`).toBe(true);
  });

  it('колонка NOT NULL — IN без оговорки не пропускает пустоту', () => {
    const baseline = readFileSync(join(ROOT, BASELINE), 'utf-8');
    expect(baseline).toMatch(/\bbooking_status character varying\(\d+\) NOT NULL\b/);
    const dropped = sortMigrations(readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')))
      .filter((f) => /ALTER\s+COLUMN\s+booking_status\s+DROP\s+NOT\s+NULL/i.test(
        stripLineComments(readFileSync(join(ROOT, 'migrations', f), 'utf-8')),
      ));
    expect(dropped, 'NOT NULL снят — CHECK с IN пропустит NULL, его надо дополнить').toEqual([]);
  });
});

describe('разбор определения судит смысл, а не форму строки', () => {
  it('вид pg_dump (= ANY ARRAY) читается так же, как IN', () => {
    const dump = `ALTER TABLE ONLY public.operator_bookings ADD CONSTRAINT ${CONSTRAINT} CHECK (((booking_status)::text = ANY ((ARRAY['new'::character varying, 'cancelled'::character varying])::text[])));`;
    expect(eventsIn(dump, 'dump')).toMatchObject([{ kind: 'add', values: ['new', 'cancelled'], validated: true }]);
  });

  it('NOT VALID без VALIDATE — не проверено; снятие обнуляет', () => {
    const sql = `ALTER TABLE operator_bookings ADD CONSTRAINT ${CONSTRAINT} CHECK (booking_status IN ('new')) NOT VALID;\n` +
      `ALTER TABLE operator_bookings DROP CONSTRAINT IF EXISTS ${CONSTRAINT};`;
    expect(eventsIn(sql, 'x').map((e) => e.kind)).toEqual(['add', 'drop']);
    expect(eventsIn(sql, 'x')[0]).toMatchObject({ validated: false });
  });

  it('упоминание в комментарии — не определение', () => {
    expect(eventsIn(`-- ADD CONSTRAINT ${CONSTRAINT} CHECK (booking_status IN ('x'))\nSELECT 1;`, 'c')).toEqual([]);
  });
});

// ── Писатель, принимавший слово вне словаря ─────────────────────────────────

const { clientQuery, plainQuery } = vi.hoisted(() => ({ clientQuery: vi.fn(), plainQuery: vi.fn() }));

vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-op', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-1') }));
vi.mock('@/lib/operators/team-access', () => ({
  requireTeamPermission: vi.fn(async () => null),
  operatorAccess: vi.fn(async () => ({ kind: 'owner' })),
  accessFailure: vi.fn(),
  ownerOnlyDenied: vi.fn(),
}));
vi.mock('@/lib/payments/slot-counter', () => ({ releaseSlotsForCancelledBooking: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: (_k: string, from: string, to: string) => `${from} -> ${to}`,
}));
vi.mock('@/lib/database', () => ({
  query: plainQuery,
  transaction: async (fn: (c: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
}));

import { PUT } from '@/app/api/operator/bookings/[id]/route';

/** Что роут записал в booking_status: параметр, стоящий за `booking_status = $n` в отправленном UPDATE. */
function writtenStatus(): string | undefined {
  const call = clientQuery.mock.calls.find(([sql]) => /^\s*UPDATE operator_bookings/.test(String(sql)));
  if (!call) return undefined;
  const [sql, values] = call as [string, unknown[]];
  const n = /booking_status = \$(\d+)/.exec(sql);
  return n ? String(values[Number(n[1]) - 1]) : undefined;
}

const put = (body: unknown) => PUT(
  new NextRequest('https://vedarai.ru/api/operator/bookings/7', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }),
  { params: Promise.resolve({ id: '7' }) },
);

describe('PUT /api/operator/bookings/[id] пишет только слова словаря', () => {
  beforeEach(() => {
    clientQuery.mockReset();
    clientQuery.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ booking_status: 'confirmed' }] };
      return { rows: [{ id: '7', user_id: 'tourist-1' }] };
    });
    plainQuery.mockReset();
    plainQuery.mockResolvedValue({ rows: [] });
  });

  it('старое слово `pending` («ждёт подтверждения») пишется как `new`', async () => {
    const res = await put({ status: 'pending' });
    expect(res.status).toBe(200);
    expect(writtenStatus()).toBe('new');
  });

  it.each(['new', 'pending', 'confirmed', 'completed', 'cancelled'])('принятое «%s» уходит в базу словарным', async (status) => {
    const res = await put({ status });
    expect(res.status).toBe(200);
    expect(BOOKING_STATUSES as readonly string[]).toContain(writtenStatus());
  });

  it('слово вне словаря и не синоним — 400, UPDATE не уходит', async () => {
    const res = await put({ status: 'rejected' });
    expect(res.status).toBe(400);
    expect(clientQuery).not.toHaveBeenCalled();
  });
});
