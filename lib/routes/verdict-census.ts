/**
 * lib/routes/verdict-census.ts
 *
 * Перепись вердиктов: какой ответ схема даёт СЕГОДНЯ на всех маршрутах.
 *
 * Владелец сформулировал опасение до выката: «не пережестить, а то все
 * маршруты станут красными». Проверить это можно ровно одним способом —
 * посчитать вердикт на всём справочнике и посмотреть на распределение.
 * Рассуждения о порогах без такой картинки — гадание.
 *
 * Перепись гоняет ТОТ ЖЕ collectRouteSignals и ТОТ ЖЕ goVerdict, что и
 * экран. Быстрая пересборка «одним запросом со всеми алертами сразу» была бы
 * второй реализацией правил, и мерила бы она себя, а не то, что видит
 * человек. Медленнее, зато честно.
 *
 * READ-ONLY: ничего не пишет.
 */

import { pool } from '@/lib/db-pool';
import { collectRouteSignals } from '@/lib/routes/collect-signals';
import { goVerdict, type VerdictStatus, type VerdictReasonCode } from '@/lib/routes/go-verdict';

/** Сколько маршрутов считать одновременно. Больше — тяжелее пулу. */
const CONCURRENCY = 8;

export interface VerdictCensus {
  /** Сколько маршрутов вообще есть в справочнике. */
  routes_total: number;
  /** Сколько посчитано. Меньше total бывает только при явном limit. */
  routes_counted: number;
  /** Если счёт урезан — это сказано, а не спрятано за красивой цифрой. */
  limited_to: number | null;
  by_status: Record<VerdictStatus, number>;
  by_code: Record<string, number>;
  /** «Не смогли узнать» по каждому источнику. Рост здесь — отказ, не погода. */
  signal_null: { alerts: number; volcanoes: number; season: number };
  /** «Узнали, и там пусто». Отличается от предыдущего по смыслу. */
  signal_empty: { alerts: number; volcanoes: number };
  /** Доля зелёных в процентах — цифра, ради которой всё это считается. */
  green_pct: number;
  /** По три примера на статус: распределение без имён нечитаемо. */
  examples: Record<VerdictStatus, Array<{ id: string; title: string; reason: string }>>;
  duration_ms: number;
}

interface RouteRow { id: string; title: string | null }

/** Разложить массив по пачкам, чтобы не открывать 300 соединений разом. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runVerdictCensus(limit?: number): Promise<VerdictCensus> {
  const startedAt = Date.now();

  const totalRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)`,
  );
  const routes_total = parseInt(totalRes.rows[0]?.n ?? '0', 10);

  const listRes = await pool.query<RouteRow>(
    limit
      ? `SELECT id::text, title FROM kamchatka_routes
          WHERE (is_visible = TRUE OR is_visible IS NULL)
          ORDER BY id LIMIT $1`
      : `SELECT id::text, title FROM kamchatka_routes
          WHERE (is_visible = TRUE OR is_visible IS NULL)
          ORDER BY id`,
    limit ? [limit] : [],
  );

  const by_status: Record<VerdictStatus, number> = { go: 0, caution: 0, no: 0 };
  const by_code: Record<string, number> = {};
  const signal_null = { alerts: 0, volcanoes: 0, season: 0 };
  const signal_empty = { alerts: 0, volcanoes: 0 };
  const examples: Record<VerdictStatus, Array<{ id: string; title: string; reason: string }>> = {
    go: [], caution: [], no: [],
  };

  await mapLimit(listRes.rows, CONCURRENCY, async (r) => {
    const signals = await collectRouteSignals(r.id);
    const v = goVerdict(signals);

    by_status[v.status] += 1;
    by_code[v.code as VerdictReasonCode] = (by_code[v.code] ?? 0) + 1;

    if (signals.alerts === null) signal_null.alerts += 1;
    else if (signals.alerts.length === 0) signal_empty.alerts += 1;
    if (signals.volcanoes === null) signal_null.volcanoes += 1;
    else if (signals.volcanoes.length === 0) signal_empty.volcanoes += 1;
    if (signals.inSeason === null) signal_null.season += 1;

    if (examples[v.status].length < 3) {
      examples[v.status].push({ id: r.id, title: r.title ?? '(без названия)', reason: v.reason });
    }
  });

  const routes_counted = listRes.rows.length;

  return {
    routes_total,
    routes_counted,
    limited_to: limit ?? null,
    by_status,
    by_code,
    signal_null,
    signal_empty,
    // Ноль маршрутов — ноль процентов, а не «сто процентов зелёных».
    green_pct: routes_counted > 0
      ? Math.round((by_status.go / routes_counted) * 1000) / 10
      : 0,
    examples,
    duration_ms: Date.now() - startedAt,
  };
}
