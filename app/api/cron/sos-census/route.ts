/**
 * GET /api/cron/sos-census?days=30&limit=50 — кто шлёт SOS. Bearer CRON_SECRET.
 * Только читает.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * 02.09 в канал пришёл SOS без имени, телефона, координат и типа — с одним
 * IP дата-центра. Владелец: «мне нужно понять, кто шлёт SOS». Ответить было
 * нечем: канал показывает то, что приёмник решил показать, а в базе лежит
 * больше — user-agent, сессия, источник, авторизация, время. Строки
 * sos_events не отдавал ни один роут, только счётчики за неделю.
 *
 * Перепись отдаёт СЫРЫЕ строки и сводки по IP, user-agent и классу источника
 * (origin_class, миграция 928; у строк до неё — NULL, и он так и называется:
 * «не классифицировался», а не «неизвестный источник» — это разные вещи).
 *
 * Приговора здесь нет. Один и тот же IP с одним и тем же user-agent пять раз
 * за минуту — факт; «это сканер» — вывод, и его делает человек.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface SosRow {
  id: string;
  created_at: string;
  status: string | null;
  outcome: string | null;
  origin_class: string | null;
  source: string | null;
  relayed_by: string | null;
  ip: string | null;
  user_agent: string | null;
  user_id: string | null;
  session_id: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  tourist_name: string | null;
  tourist_phone: string | null;
  emergency_type: string | null;
  message: string | null;
  notes: string | null;
}

interface Bucket { key: string; n: number; first: string; last: string }

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Сводка по одному признаку. NULL получает своё имя, а не сливается с
 * пустой строкой: «user-agent не передан» и «user-agent пустой» — разные
 * улики.
 */
function bucketize(rows: SosRow[], pick: (r: SosRow) => string | null, nullName: string): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const r of rows) {
    const key = pick(r) ?? nullName;
    const b = m.get(key);
    if (b) {
      b.n += 1;
      if (r.created_at < b.first) b.first = r.created_at;
      if (r.created_at > b.last) b.last = r.created_at;
    } else {
      m.set(key, { key, n: 1, first: r.created_at, last: r.created_at });
    }
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const days = clampInt(request.nextUrl.searchParams.get('days'), 30, 1, 365);
  const limit = clampInt(request.nextUrl.searchParams.get('limit'), 50, 1, 200);

  try {
    // ip_address — inet; наружу текстом, чтобы JSON не спотыкался.
    // Интервал — параметром с приведением, не конкатенацией (sql-interval-not-concatenated).
    const { rows } = await pool.query<SosRow>(
      `SELECT id::text AS id,
              created_at::text AS created_at,
              status, outcome, origin_class, source, relayed_by,
              host(ip_address) AS ip,
              user_agent,
              user_id::text AS user_id,
              session_id,
              lat, lng, accuracy,
              tourist_name, tourist_phone, emergency_type,
              LEFT(message, 200) AS message,
              LEFT(notes, 300) AS notes
         FROM sos_events
        WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY created_at DESC
        LIMIT $2::int`,
      [days, limit],
    );

    const { rows: totals } = await pool.query<{ total: string; open: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'false_alarm'))::text AS open
         FROM sos_events
        WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')`,
      [days],
    );

    const empty = rows.filter(r =>
      r.lat == null && r.lng == null
      && !r.tourist_name && !r.tourist_phone && !r.emergency_type && !r.message
      && !r.user_id && !r.session_id,
    );

    return NextResponse.json({
      success: true,
      window_days: days,
      total_in_window: parseInt(totals[0]?.total ?? '0', 10),
      open_in_window: parseInt(totals[0]?.open ?? '0', 10),
      returned: rows.length,
      truncated: rows.length === limit,
      // Пустые по СОДЕРЖИМОМУ — не то же, что «неустановленный источник»:
      // человек без GPS и без имени тоже сюда попадает. Считается отдельно,
      // чтобы было видно, сколько сигналов вообще не о чем.
      empty_by_content: empty.length,
      by_ip: bucketize(rows, r => r.ip, '(ip не записан)'),
      by_user_agent: bucketize(rows, r => r.user_agent, '(user-agent не передан)'),
      by_origin_class: bucketize(rows, r => r.origin_class, '(не классифицировался — до миграции 928)'),
      by_status: bucketize(rows, r => r.status, '(статус пуст)'),
      by_source: bucketize(rows, r => r.source, '(источник пуст)'),
      rows,
    });
  } catch (err) {
    // Перепись, которая не смогла прочитать, обязана сказать это вслух:
    // пустой список здесь читался бы как «SOS не было» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sos-census] чтение sos_events не удалось:', message);
    return NextResponse.json({ success: false, refused: true, error: message }, { status: 502 });
  }
}
