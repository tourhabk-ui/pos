/**
 * Сторож #1428: победитель A/B применяется под замком строки, одной
 * транзакцией.
 *
 * До 02.09 скидка и статус completed шли отдельными pool.query. Два
 * пересёкшихся прогона крона применяли скидку дважды, а price_old второго
 * запоминал уже сниженную цену. Тест ИСПОЛНЯЕТ executeABScaleWinner на
 * записывающем клиенте и проверяет решение, а не текст:
 *
 *   - записи идут ТОЛЬКО через клиент транзакции, никогда через pool.query;
 *   - первым действием в транзакции — FOR UPDATE SKIP LOCKED с повторной
 *     проверкой status = 'running';
 *   - занятая строка — пропуск вслух, без единой записи;
 *   - отказ записи — ROLLBACK, соединение возвращено, ошибка названа.
 *
 * С 23.11 скидка идёт не своим UPDATE, а дверью автомата (слово владельца:
 * «цена тура меняется только через одну дверь»). Дверь здесь подменена
 * записывающей заглушкой: тест судит, что исполнитель зовёт её соединением
 * своей транзакции, считает цену от того, что выйдет на сайт, и называет
 * исход своими словами. Саму дверь на схеме прода судит
 * tests/integration/tour-automaton.pg.test.ts.
 *
 * Оговорка §4.0: гонку двух настоящих соединений тест не гоняет — это
 * замоканный клиент. Он доказывает форму (замок стоит первым и держит обе
 * записи), а не поведение PostgreSQL под SKIP LOCKED; последнее — свойство
 * самой базы, проверенное её тестами, не нашими.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
interface Call { via: 'pool' | 'client'; sql: string; params?: unknown[] }

const calls: Call[] = [];
let released = 0;
/** Соединение последней транзакции: дверь обязана получить именно его. */
let lastClient: unknown = null;

interface DoorView { operatorId: string; published: boolean; hasDraft: boolean; live: Row; effective: Row; ownerPending: string[] }
const door = {
  reads: [] as Array<{ client: unknown; tourId: string }>,
  proposals: [] as Array<{ client: unknown; tourId: string; source: string; input: Row }>,
  view: null as DoorView | null,
  outcome: 'pending' as 'pending' | 'written' | 'kept_owner' | 'not_found' | 'unchanged',
  fail: null as Error | null,
};
const viewOf = (price: unknown, ownerPending: string[] = []): DoorView => ({
  operatorId: 'p1', published: true, hasDraft: false, live: { base_price: price }, effective: { base_price: price }, ownerPending,
});

vi.mock('@/lib/tours/tour-change', () => ({
  readTourForAutomaton: async (client: unknown, tourId: string) => {
    calls.push({ via: 'client', sql: `ДВЕРЬ: чтение тура ${tourId}` });
    door.reads.push({ client, tourId });
    return door.view;
  },
  proposeTourChange: async (client: unknown, opts: { tourId: string; source: string; input: Row }) => {
    calls.push({ via: 'client', sql: `ДВЕРЬ: правка тура ${opts.tourId}` });
    if (door.fail) throw door.fail;
    door.proposals.push({ client, tourId: opts.tourId, source: opts.source, input: opts.input });
    return door.outcome === 'kept_owner' ? { outcome: 'kept_owner', fields: ['base_price'] } : { outcome: door.outcome };
  },
}));
let clientHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;
let poolHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ via: 'pool', sql, params });
      return poolHandler(sql, params);
    },
    connect: () => {
      const client = {
        query: (sql: string, params?: unknown[]) => {
          calls.push({ via: 'client', sql, params });
          return clientHandler(sql, params);
        },
        release: () => { released += 1; },
      };
      lastClient = client;
      return Promise.resolve(client);
    },
  },
}));

import { executeABScaleWinner } from '@/lib/agents/execution/handlers/ab-scale-executor';

const EXP = {
  id: 'e1e1e1e1-0000-0000-0000-000000000001',
  name: 'Скидка на Горелый',
  created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  variant_a: { label: 'A', tour_ids: [1] },
  variant_b: { label: 'B', tour_ids: [2], discount_pct: 15 },
};

const task = { approval_id: 'x', executor_agent_id: 'ab', action_type: 'ab_scale_winner', description: '', context: {}, due_date: '' };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const sqls = (via: 'pool' | 'client') => calls.filter(c => c.via === via).map(c => norm(c.sql));

beforeEach(() => {
  calls.length = 0;
  released = 0;
  lastClient = null;
  door.reads.length = 0;
  door.proposals.length = 0;
  door.view = viewOf('10000.00');
  door.outcome = 'pending';
  door.fail = null;
  delete process.env.TELEGRAM_BOT_TOKEN;
  poolHandler = async (sql) => {
    if (/FROM agent_experiments/.test(sql)) return { rows: [{ id: EXP.id }], rowCount: 1 };
    throw new Error(`pool.query не ожидался: ${norm(sql).slice(0, 60)}`);
  };
});

describe('executeABScaleWinner: одна транзакция под замком строки', () => {
  it('B выигрывает: BEGIN → FOR UPDATE SKIP LOCKED → счёт → скидка дверью → completed → COMMIT, всё клиентом', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [EXP], rowCount: 1 };
      if (/UNION ALL/.test(sql)) return { rows: [{ variant: 'a', bookings: 1 }, { variant: 'b', bookings: 5 }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    const r = await executeABScaleWinner(task);
    expect(r.success).toBe(true);
    expect(r.errors).toEqual([]);

    const c = sqls('client');
    expect(c[0]).toBe('BEGIN');
    expect(c[1]).toMatch(/FROM agent_experiments WHERE id = \$1 AND status = 'running' FOR UPDATE SKIP LOCKED/);
    // Скидка — дверью: чтение тура под замком, затем правка; своего UPDATE тура нет.
    expect(c.some(s => /UPDATE operator_tours/.test(s))).toBe(false);
    const read = c.indexOf('ДВЕРЬ: чтение тура 2');
    const write = c.indexOf('ДВЕРЬ: правка тура 2');
    expect(read).toBeGreaterThan(1);
    expect(write).toBeGreaterThan(read);
    expect(c.findIndex(s => /UPDATE agent_experiments SET status = 'completed'/.test(s))).toBeGreaterThan(write);
    expect(c[c.length - 1]).toBe('COMMIT');
    // Дверь получила соединение этой транзакции: скидка и статус — либо оба, либо ни одного.
    expect(door.reads).toEqual([{ client: lastClient, tourId: '2' }]);
    // Цена из базы приходит строкой «10000.00»: скидка 15% — 8500, прежняя цена — числом.
    expect(door.proposals).toEqual([{
      client: lastClient, tourId: '2', source: 'ab-scale', input: { base_price: 8500, price_old: 10000 },
    }]);
    // Через пул — только список кандидатов, ни одной записи.
    expect(sqls('pool')).toHaveLength(1);
    expect(sqls('pool')[0]).not.toMatch(/UPDATE/);
    expect(released).toBe(1);
    // «На проверке» не выдаётся за «применено».
    const told = r.changes_made.join('\n');
    expect(told).toMatch(/Скидка 15% группе B \(B выиграл на [\d.]+%\): ждёт проверки администратора — 1; записано в туры, которых нет на сайте, — 0/);
    expect(told).not.toMatch(/Применена скидка/);
  });

  it('тур не на сайте — «записано», а не «на проверке»; исходы считаются порознь', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [{ ...EXP, variant_b: { label: 'B', tour_ids: [2, 3], discount_pct: 10 } }], rowCount: 1 };
      if (/UNION ALL/.test(sql)) return { rows: [{ variant: 'a', bookings: 1 }, { variant: 'b', bookings: 9 }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    door.outcome = 'written';
    const r = await executeABScaleWinner(task);
    expect(r.success).toBe(true);
    expect(door.proposals.map((p) => [p.tourId, p.input])).toEqual([
      ['2', { base_price: 9000, price_old: 10000 }], ['3', { base_price: 9000, price_old: 10000 }],
    ]);
    expect(r.changes_made.join('\n')).toMatch(/ждёт проверки администратора — 0; записано в туры, которых нет на сайте, — 2/);
  });

  it('владелец сам отправил цену на проверку, тура нет, цена не записана — пропуск вслух, эксперимент закрыт', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [EXP], rowCount: 1 };
      if (/UNION ALL/.test(sql)) return { rows: [{ variant: 'a', bookings: 0 }, { variant: 'b', bookings: 4 }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    for (const [view, words] of [
      [viewOf('10000.00', ['base_price']), 'пропущено: владелец сам отправил цену на проверку — 1'],
      [viewOf('10000.00', ['price_old']), 'пропущено: владелец сам отправил цену на проверку — 1'],
      [null, 'тур не найден — 1'],
      [viewOf(null), 'пропущено: цена не записана — 1'],
      [viewOf('0'), 'пропущено: цена не записана — 1'],
    ] as const) {
      calls.length = 0;
      door.proposals.length = 0;
      door.view = view as DoorView | null;
      const r = await executeABScaleWinner(task);
      expect(r.success, words).toBe(true);
      expect(door.proposals, words).toEqual([]);
      expect(r.changes_made.join('\n'), words).toContain(words);
      expect(r.changes_made.join('\n')).toContain('ждёт проверки администратора — 0');
      expect(sqls('client').some(s => /status = 'completed'/.test(s)), words).toBe(true);
    }
    // Дверь сама отказала (владелец успел отправить цену между чтением и записью) — тот же счёт.
    door.view = viewOf('10000.00');
    door.outcome = 'kept_owner';
    const late = await executeABScaleWinner(task);
    expect(late.changes_made.join('\n')).toContain('пропущено: владелец сам отправил цену на проверку — 1');
  });

  it('строку держит другой прогон — пропуск вслух, ни одной записи', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    const r = await executeABScaleWinner(task);
    expect(r.success).toBe(true);
    expect(r.changes_made.join('\n')).toMatch(/занят другим прогоном или уже завершён/);
    const c = sqls('client');
    // Именно запись: «FOR UPDATE» в замке — не запись.
    expect(c.some(s => /^UPDATE /.test(s))).toBe(false);
    expect(c[c.length - 1]).toBe('COMMIT');
    expect(released).toBe(1);
  });

  it('скидка не записалась — ROLLBACK, статус не тронут, ошибка названа', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [EXP], rowCount: 1 };
      if (/UNION ALL/.test(sql)) return { rows: [{ variant: 'a', bookings: 0 }, { variant: 'b', bookings: 4 }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    door.fail = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const r = await executeABScaleWinner(task);
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/deadlock detected/);
    const c = sqls('client');
    expect(c).toContain('ROLLBACK');
    expect(c.some(s => /status = 'completed'/.test(s))).toBe(false);
    expect(released).toBe(1);
  });

  it('A выигрывает — completed без скидки, всё равно под замком', async () => {
    clientHandler = async (sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [EXP], rowCount: 1 };
      if (/UNION ALL/.test(sql)) return { rows: [{ variant: 'a', bookings: 6 }, { variant: 'b', bookings: 1 }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    const r = await executeABScaleWinner(task);
    expect(r.success).toBe(true);
    const c = sqls('client');
    expect(c.some(s => /UPDATE operator_tours/.test(s))).toBe(false);
    // Скидки нет — дверь не тронута вовсе.
    expect(door.reads).toEqual([]);
    expect(door.proposals).toEqual([]);
    expect(c.some(s => /status = 'completed'/.test(s) && /\$2/.test(s))).toBe(true);
    expect(calls.find(x => /status = 'completed'/.test(x.sql))?.params).toEqual([EXP.id, 'a']);
  });
});
