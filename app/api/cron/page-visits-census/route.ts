/**
 * GET /api/cron/page-visits-census?path=/tools/equipment&path=/planning&days=30
 * — из чего состоят «людские» просмотры страницы. Только чтение.
 *
 * Повод (21.11, владелец: «проверь логи и нужно разобраться с причиной такого
 * поведения»): на /hub/admin/traffic у /tools/equipment 75 просмотров при
 * медиане видимого времени 1 с и уходе 100 %, у /planning — 371 при 5 с и
 * 98 %. Человек за секунду форму не прочтёт. Витрина говорит ГДЕ уходят, но
 * не из чего эти визиты: один адрес или многие, откуда пришли, с какого
 * устройства, маяк был или нет, в какие часы.
 *
 * Фильтр «людей» тот же, что у витрины (is_bot = FALSE AND is_self = FALSE),
 * иначе перепись объясняла бы другие числа. В ответе только счётчики: ни
 * адресов, ни хэшей, ни полных ссылок — у источника перехода берётся хост
 * (полная ссылка может нести параметры с данными человека), и лог прогона
 * workflow публичный. Хэш адреса участвует только в подсчёте «сколько
 * просмотров с самого частого адреса».
 *
 * Три исхода (§4.0): числа по каждому замеру; упавший замер — в failed со
 * SQLSTATE, а не пустым списком; путь без просмотров — views: 0.
 * Запуск — маркер prod-check.json. Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HUMAN = 'is_bot = FALSE AND is_self = FALSE';
const MAX_PATHS = 5;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

/** Путь страницы: начинается с «/», без параметров, без пробелов. */
export function cleanPath(raw: string): string | null {
  const p = raw.trim();
  return /^\/[\w\-./[\]]{0,200}$/.test(p) ? p : null;
}

type Row = Record<string, unknown>;
interface Measured { value: unknown; failed: string | null }

async function measure(name: string, sql: string, params: unknown[]): Promise<Measured> {
  try {
    return { value: (await pool.query<Row>(sql, params)).rows, failed: null };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(`[page-visits-census] замер «${name}» не удался:`, `SQLSTATE=${e?.code ?? 'нет'}`, (e?.message ?? '').slice(0, 200));
    return { value: null, failed: `${name}: ${e?.code ?? 'ERR'}` };
  }
}

const WINDOW = `created_at >= NOW() - make_interval(days => $2::int)`;

/** Замеры одной страницы — каждый своим запросом, отказ одного не роняет прочие. */
export const MEASURES: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: 'totals',
    sql: `SELECT COUNT(*)::int AS views,
                 COUNT(DISTINCT visitor_hash)::int AS visitor_days,
                 COUNT(DISTINCT ip_hash)::int AS addresses,
                 COUNT(*) FILTER (WHERE ip_hash IS NULL)::int AS no_address,
                 COUNT(*) FILTER (WHERE NOT client_beacon)::int AS no_beacon,
                 COUNT(*) FILTER (WHERE dwell_ms IS NULL)::int AS no_dwell,
                 COUNT(*) FILTER (WHERE from_path IS NULL)::int AS entries,
                 COUNT(*) FILTER (WHERE session_id IS NULL)::int AS no_session,
                 COUNT(*) FILTER (WHERE is_not_found)::int AS not_found,
                 percentile_cont(0.25) WITHIN GROUP (ORDER BY dwell_ms) FILTER (WHERE dwell_ms IS NOT NULL)::int AS dwell_p25_ms,
                 percentile_cont(0.5)  WITHIN GROUP (ORDER BY dwell_ms) FILTER (WHERE dwell_ms IS NOT NULL)::int AS dwell_p50_ms,
                 percentile_cont(0.75) WITHIN GROUP (ORDER BY dwell_ms) FILTER (WHERE dwell_ms IS NOT NULL)::int AS dwell_p75_ms
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}`,
  },
  {
    // Сколько просмотров дал самый частый адрес, второй, … — без самих хэшей.
    name: 'views_per_address_top',
    sql: `SELECT COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN} AND ip_hash IS NOT NULL
           GROUP BY ip_hash ORDER BY COUNT(*) DESC LIMIT 8`,
  },
  {
    name: 'device',
    sql: `SELECT COALESCE(device, 'не записано') AS device, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    name: 'browser_family',
    sql: `SELECT COALESCE(ua_family, 'не записано') AS family, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  },
  {
    // Только хост: полная ссылка может нести параметры с данными человека.
    name: 'referrer_host',
    sql: `SELECT COALESCE(substring(referrer from '^[a-z]+://([^/?#]+)'), 'нет') AS host, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  },
  {
    name: 'from_path',
    sql: `SELECT COALESCE(split_part(from_path, '?', 1), 'вход на сайт') AS from_path, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  },
  {
    name: 'by_day',
    sql: `SELECT to_char(created_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS day, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 1`,
  },
  {
    name: 'by_hour_kamchatka',
    sql: `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kamchatka')::int AS hour, COUNT(*)::int AS views
            FROM page_views WHERE path = $1 AND ${WINDOW} AND ${HUMAN}
           GROUP BY 1 ORDER BY 1`,
  },
  {
    // Что было после этой страницы в том же визите: уход или куда.
    name: 'next_path',
    sql: `WITH v AS (
            SELECT path, session_id,
                   LEAD(split_part(path, '?', 1)) OVER (PARTITION BY session_id ORDER BY created_at) AS next_path
              FROM page_views WHERE ${WINDOW} AND ${HUMAN} AND session_id IS NOT NULL
          )
          SELECT COALESCE(next_path, 'уход') AS next_path, COUNT(*)::int AS views
            FROM v WHERE path = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  },
  {
    name: 'client_errors',
    sql: `SELECT kind, COUNT(*)::int AS n
            FROM client_errors WHERE path = $1 AND ${WINDOW} AND NOT is_bot AND NOT is_self
           GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  },
];

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeCompare(getCronSecret(request) ?? '', secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const paths = [...new Set(url.searchParams.getAll('path').map(cleanPath).filter((p): p is string => p !== null))].slice(0, MAX_PATHS);
  if (paths.length === 0) {
    return NextResponse.json({ error: 'Нужен хотя бы один path=/…' }, { status: 400 });
  }
  const daysRaw = Number(url.searchParams.get('days') ?? DEFAULT_DAYS);
  const days = Number.isFinite(daysRaw) ? Math.min(MAX_DAYS, Math.max(1, Math.round(daysRaw))) : DEFAULT_DAYS;

  const pages = [];
  for (const path of paths) {
    const out: Record<string, unknown> = { path };
    const failed: string[] = [];
    for (const m of MEASURES) {
      const r = await measure(m.name, m.sql, [path, days]);
      out[m.name] = r.value;
      if (r.failed) failed.push(r.failed);
    }
    out.failed = failed;
    pages.push(out);
  }
  return NextResponse.json({ days, filter: HUMAN, pages });
}
