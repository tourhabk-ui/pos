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
import { KAMCHATKA_BBOX } from '@/lib/services/safety/wildfire-firms';
import {
  DEFAULT_CELL_DEG,
  DEFAULT_MIN_DAYS,
  distanceKm,
  parseFirmsRows,
  persistentCells,
  type FirmsRow,
} from '@/lib/services/safety/firms-persistence';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** API области отдаёт до 10 суток (раньше было 5): просим больше, при отказе — меньше, и говорим, сколько получили. */
const WINDOWS = [10, 5];
const NEAR_KM = 25;
const NEAR_TYPES = ['volcano', 'hot_spring', 'geyser', 'lake', 'camp', 'cabin', 'viewpoint', 'mountain'];

interface AlertRow {
  id: string;
  external_id: string;
  severity: number | null;
  created_at: string;
  expires_at: string | null;
  title: string | null;
}
interface PlaceRow { id: string; name: string; location_type: string | null; lat: number; lng: number }

async function fetchWindow(key: string): Promise<{ days: number; csv: string } | { error: string }> {
  const { west, south, east, north } = KAMCHATKA_BBOX;
  let lastError = 'нет ответа';
  for (const days of WINDOWS) {
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/VIIRS_SNPP_NRT/${west},${south},${east},${north}/${days}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) { lastError = `http ${res.status} на ${days} сут.`; continue; }
      const csv = await res.text();
      // Ошибка ключа или окна FIRMS отдаёт ТЕКСТОМ с кодом 200: без заголовка колонок это не CSV.
      if (!/latitude/i.test(csv.split('\n')[0] ?? '')) { lastError = `не CSV на ${days} сут.: ${csv.slice(0, 120)}`; continue; }
      return { days, csv };
    } catch (e) {
      lastError = `${e instanceof Error ? e.message : String(e)} на ${days} сут.`;
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
  const cells = persistentCells(rows, { cellDeg: DEFAULT_CELL_DEG, minDays: 2 });

  // Что приём записал по этим же местам: id вида firms/<дата>/<lat>,<lng>, одна запись на сутки+ячейку.
  let alertsByCell: Record<string, AlertRow[]> | null = null;
  let places: PlaceRow[] | null = null;
  try {
    const { rows: alerts } = await pool.query<AlertRow>(
      `SELECT id::text, external_id, severity::int AS severity, created_at::text, expires_at::text, title
         FROM external_alerts
        WHERE external_id LIKE 'firms/%' AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at`,
    );
    alertsByCell = {};
    for (const c of cells) {
      alertsByCell[c.key] = alerts.filter((a) => {
        const m = /^firms\/[\d-]+\/(-?[\d.]+),(-?[\d.]+)$/.exec(a.external_id);
        return m ? distanceKm(Number(m[1]), Number(m[2]), c.lat, c.lng) <= 12 : false;
      });
    }
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

  const out = cells.map((c) => ({
    ...c,
    frpMean: Math.round(c.frpMean * 10) / 10,
    spreadKm: Math.round(c.spreadKm * 100) / 100,
    nearby: places
      ? places
          .map((p) => ({ name: p.name, type: p.location_type, km: Math.round(distanceKm(c.lat, c.lng, p.lat, p.lng) * 10) / 10 }))
          .filter((p) => p.km <= NEAR_KM)
          .sort((a, b) => a.km - b.km)
          .slice(0, 6)
      : null,
    alerts: alertsByCell
      ? alertsByCell[c.key].map((a) => ({ external_id: a.external_id, severity: a.severity, created_at: a.created_at, expires_at: a.expires_at, title: a.title }))
      : null,
  }));

  return NextResponse.json({
    success: true,
    asked: true,
    window_days: got.days,
    rows_total: rows.length,
    days_seen: [...new Set(rows.map((r) => r.acqDate))].sort(),
    min_days_default: DEFAULT_MIN_DAYS,
    cells_repeating: out.length,
    cells: out.slice(0, 40),
  });
}
