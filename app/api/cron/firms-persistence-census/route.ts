/**
 * GET /api/cron/firms-persistence-census — какие термоточки FIRMS стоят на
 * месте несколько суток. Bearer CRON_SECRET, только чтение.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Скрин владельца 09.10: на радаре «Термоточки (возможен пожар): 1 очаг(ов),
 * 54.62°N 160.30°E», и точка висит неделю в одном месте. Приём
 * (`wildfire-firms`) смотрит только сутки и кормит `saveEvent`, а тот
 * сворачивает повторы с тем же заголовком и телом в ОДНУ запись, продлевая ей
 * срок: у источника, стоящего на месте, строка живёт, пока он виден, и
 * текст её — первого дня. Что именно стоит на месте — пожар в тундре или
 * постоянный источник тепла — по строке из ленты не видно.
 *
 * Перепись отвечает ФАКТАМИ, а вывода не выносит: сколько суток, сколько
 * обнаружений, насколько они разбросаны, мощность, день/ночь, что из мест
 * нашей базы лежит рядом. Правило для приёма выбирается по этим числам, а не
 * по догадке о том, что там горит.
 *
 * Три исхода у самой переписи (§4.0): нет ключа FIRMS на проде / FIRMS не
 * ответил — «не смогли спросить», НЕ «таких точек нет»; ответил и пусто —
 * «в окне такого нет».
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  DEFAULT_MIN_DAYS,
  DEFAULT_RADIUS_KM,
  KAMCHATKA_BBOX,
  STATIC_FEATURE_KM,
  distanceKm,
  judgeStatic,
  parseFirmsRows,
  persistentClusters,
  type FirmsRow,
  type NearFeature,
} from '@/lib/services/safety/firms-persistence';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** API области отдаёт до 10 суток (раньше было 5): просим больше, при отказе — меньше, и говорим, сколько получили. */
const WINDOWS = [10, 5];
const NEAR_KM = 25;
const NEAR_TYPES = ['volcano', 'hot_spring', 'geyser', 'lake', 'camp', 'cabin', 'viewpoint', 'mountain'];
/** Те же типы, по которым решает приём (wildfire-firms.HEAT_FEATURE_TYPES): вердикт переписи = вердикт приёма. */
const HEAT_TYPES = ['volcano', 'geyser', 'hot_spring'];

interface AlertRow {
  id: string;
  external_id: string;
  severity: number | null;
  created_at: string;
  expires_at: string | null;
  title: string | null;
}
interface PlaceRow { id: string; name: string; location_type: string | null; lat: number; lng: number }

async function fetchWindow(key: string): Promise<{ days: number; csv: string; refused: string[] } | { error: string }> {
  const { west, south, east, north } = KAMCHATKA_BBOX;
  let lastError = 'нет ответа';
  // Отказы окон, до которого дошли раньше успешного: «10 суток не дали» — факт, а не молчание.
  const refused: string[] = [];
  for (const days of WINDOWS) {
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/VIIRS_SNPP_NRT/${west},${south},${east},${north}/${days}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) { lastError = `http ${res.status} на ${days} сут.`; refused.push(lastError); continue; }
      const csv = await res.text();
      // Ошибка ключа или окна FIRMS отдаёт ТЕКСТОМ с кодом 200: без заголовка колонок это не CSV.
      if (!/latitude/i.test(csv.split('\n')[0] ?? '')) { lastError = `не CSV на ${days} сут.: ${csv.slice(0, 120)}`; refused.push(lastError); continue; }
      return { days, csv, refused };
    } catch (e) {
      lastError = `${e instanceof Error ? e.message : String(e)} на ${days} сут.`;
      refused.push(lastError);
    }
  }
  return { error: lastError };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    return NextResponse.json({ success: true, asked: false, reason: 'no_key', note: 'FIRMS_MAP_KEY на проде не задан: «не смогли спросить», не «таких точек нет».' });
  }

  const got = await fetchWindow(key);
  if ('error' in got) {
    console.error('[firms-persistence-census] FIRMS не ответил', got.error);
    return NextResponse.json({ success: true, asked: false, reason: 'firms_failed', error: got.error });
  }

  const rows: FirmsRow[] = parseFirmsRows(got.csv);
  const clusters = persistentClusters(rows, { minDays: 2 });
  const today = new Date().toISOString().slice(0, 10);

  // Что приём записал по этим же местам: id вида firms/<дата>/<lat>,<lng>, одна запись на сутки+ячейку.
  let alerts: AlertRow[] | null = null;
  let places: PlaceRow[] | null = null;
  try {
    const { rows: al } = await pool.query<AlertRow>(
      `SELECT id::text, external_id, severity::int AS severity, created_at::text, expires_at::text, title
         FROM external_alerts
        WHERE external_id LIKE 'firms/%' AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at`,
    );
    alerts = al;
    const { rows: pl } = await pool.query<PlaceRow>(
      `SELECT id::text, name, location_type, lat::float AS lat, lng::float AS lng
         FROM places
        WHERE is_visible = TRUE AND merged_into_id IS NULL
          AND location_type = ANY($1::text[])`,
      [NEAR_TYPES],
    );
    places = pl;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[firms-persistence-census] БД не ответила', err.code, err.message);
  }

  const out = clusters.map((c) => {
    const nearby = places
      ? places
          .map((p) => ({ name: p.name, type: p.location_type, km: Math.round(distanceKm(c.lat, c.lng, p.lat, p.lng) * 10) / 10 }))
          .filter((p) => p.km <= NEAR_KM)
          .sort((a, b) => a.km - b.km)
          .slice(0, 6)
      : null;
    // Ближайшее греющее место — тем же правилом, что и приём; БД не ответила — undefined, «не знаем».
    const heat: NearFeature | null | undefined = places
      ? (places
          .filter((p) => p.location_type !== null && HEAT_TYPES.includes(p.location_type))
          .map((p) => ({ name: p.name, type: p.location_type, km: distanceKm(c.lat, c.lng, p.lat, p.lng) }))
          .sort((a, b) => a.km - b.km)[0] ?? null)
      : undefined;
    const verdict = judgeStatic(c, today, heat);

    // Записи приёма по этому месту — СВОДКОЙ: полный список (по записи на сутки) не умещается в аннотацию CI.
    const mine = alerts
      ? alerts.filter((a) => {
          const m = /^firms\/[\d-]+\/(-?[\d.]+),(-?[\d.]+)$/.exec(a.external_id);
          return m ? distanceKm(Number(m[1]), Number(m[2]), c.lat, c.lng) <= 12 : false;
        })
      : null;

    const { members: _members, ...rest } = c;
    void _members;
    return {
      ...rest,
      frpMean: Math.round(c.frpMean * 10) / 10,
      spreadKm: Math.round(c.spreadKm * 100) / 100,
      nearby,
      heat_nearest: heat === undefined ? null : heat === null ? { none_within_25km_or_unknown: true } : { name: heat.name, km: Math.round(heat.km * 10) / 10 },
      verdict: verdict.reason,
      would_suppress: verdict.isStatic,
      alerts: mine
        ? {
            count: mine.length,
            first_created: mine[0]?.created_at ?? null,
            last_created: mine[mine.length - 1]?.created_at ?? null,
            last_expires: mine[mine.length - 1]?.expires_at ?? null,
            max_severity: mine.reduce((m, a) => Math.max(m, a.severity ?? 0), 0),
            last: mine.slice(-5).map((a) => ({ external_id: a.external_id, severity: a.severity, created_at: a.created_at, expires_at: a.expires_at })),
          }
        : null,
    };
  });

  return NextResponse.json({
    success: true,
    asked: true,
    window_days: got.days,
    window_refused: got.refused,
    rows_total: rows.length,
    days_seen: [...new Set(rows.map((r) => r.acqDate))].sort(),
    radius_km: DEFAULT_RADIUS_KM,
    static_feature_km: STATIC_FEATURE_KM,
    min_days_default: DEFAULT_MIN_DAYS,
    db_ok: places !== null && alerts !== null,
    clusters_repeating: out.length,
    clusters: out.slice(0, 40),
  });
}
