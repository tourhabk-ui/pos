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
let clientHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;
let poolHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ via: 'pool', sql, params });
      return poolHandler(sql, params);
    },
    connect: () => Promise.resolve({
      query: (sql: string, params?: unknown[]) => {
        calls.push({ via: 'client', sql, params });
        return clientHandler(sql, params);
      },
      release: () => { released += 1; },
    }),
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
  delete process.env.TELEGRAM_BOT_TOKEN;
  poolHandler = async (sql) => {
    if (/FROM agent_experiments/.test(sql)) return { rows: [{ id: EXP.id }], rowCount: 1 };
    throw new Error(`pool.query не ожидался: ${norm(sql).slice(0, 60)}`);
  };
});

describe('executeABScaleWinner: одна транзакция под замком строки', () => {
  it('B выигрывает: BEGIN → FOR UPDATE SKIP LOCKED → счёт → скидка → completed → COMMIT, всё клиентом', async () => {
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
    expect(c.findIndex(s => /UPDATE operator_tours/.test(s))).toBeGreaterThan(1);
    expect(c.findIndex(s => /UPDATE agent_experiments SET status = 'completed'/.test(s)))
      .toBeGreaterThan(c.findIndex(s => /UPDATE operator_tours/.test(s)));
    expect(c[c.length - 1]).toBe('COMMIT');
    // Через пул — только список кандидатов, ни одной записи.
    expect(sqls('pool')).toHaveLength(1);
    expect(sqls('pool')[0]).not.toMatch(/UPDATE/);
    expect(released).toBe(1);
    expect(r.changes_made.join('\n')).toMatch(/Применена скидка 15%/);
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
      if (/UPDATE operator_tours/.test(sql)) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return { rows: [], rowCount: 1 };
    };
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
    expect(c.some(s => /status = 'completed'/.test(s) && /\$2/.test(s))).toBe(true);
    expect(calls.find(x => /status = 'completed'/.test(x.sql))?.params).toEqual([EXP.id, 'a']);
  });
});
