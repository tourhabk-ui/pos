/**
 * POST /api/cron/places-geocode — поднимает плейсхолдер-места (без реального GPS:
 * 0,0 или 53.0444/158.6483 центр ПКЦ) в реальные координаты по названию через
 * Nominatim. Прод (РФ-IP) сам ходит в Nominatim; раннеру сеть не нужна.
 *
 * Bearer CRON_SECRET. Body: { limit (1..30, default 12), dry_run (default true) }.
 *
 * Безопасность данных:
 *  - геокодим только реально-именованные места (не активности/туры — NON_PLACE_RE);
 *  - пишем координаты ТОЛЬКО если результат внутри Камчатки (withinKamchatka) —
 *    иначе место остаётся как есть и помечается geocode_failed_at;
 *  - успех: lat/lng + is_visible=true (реальная точка достойна показа);
 *  - неудача/вне Камчатки/нет ответа: geocode_failed_at=NOW() (чтобы цикл-раннер
 *    не долбил нерешаемые снова и снова);
 *  - Nominatim policy: 1 запрос/сек — выдерживаем паузу между вызовами.
 *  - dry_run: ничего не пишем, только показываем что и куда бы встало.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { geocodeAddress, withinKamchatka } from '@/lib/services/geocode';
import { NON_PLACE_RE, PLACEHOLDER_COND } from '@/lib/places/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  limit: z.number().int().min(1).max(30).default(12),
  dry_run: z.boolean().default(true),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PendingRow { id: string; name: string }

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  try {
    const pendingWhere =
      `merged_into_id IS NULL AND (${PLACEHOLDER_COND})` +
      ` AND name !~* '${NON_PLACE_RE}' AND geocode_failed_at IS NULL`;

    const total = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM places WHERE ${pendingWhere}`,
    );
    const pendingTotal = parseInt(total.rows[0]?.count ?? '0', 10);

    const { rows } = await pool.query<PendingRow>(
      `SELECT id::text AS id, name FROM places WHERE ${pendingWhere} ORDER BY id LIMIT $1`,
      [data.limit],
    );

    const updated: Array<{ id: string; name: string; lat: number; lng: number; displayName: string }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const place = rows[i]!;
      if (i > 0) await sleep(1100); // Nominatim: 1 req/sec

      const geo = await geocodeAddress(`${place.name}, Камчатский край, Россия`);
      if (!geo) {
        if (!data.dry_run) {
          await pool.query(`UPDATE places SET geocode_failed_at = NOW() WHERE id = $1`, [place.id]);
        }
        skipped.push({ id: place.id, name: place.name, reason: 'не найдено в Nominatim' });
        continue;
      }
      if (!withinKamchatka(geo.lat, geo.lng)) {
        if (!data.dry_run) {
          await pool.query(`UPDATE places SET geocode_failed_at = NOW() WHERE id = $1`, [place.id]);
        }
        skipped.push({ id: place.id, name: place.name, reason: `вне Камчатки (${geo.lat.toFixed(3)},${geo.lng.toFixed(3)}) — ${geo.displayName}` });
        continue;
      }

      if (!data.dry_run) {
        await pool.query(
          `UPDATE places SET lat = $1, lng = $2, is_visible = true, geocode_failed_at = NULL WHERE id = $3`,
          [geo.lat, geo.lng, place.id],
        );
      }
      updated.push({ id: place.id, name: place.name, lat: geo.lat, lng: geo.lng, displayName: geo.displayName });
    }

    return NextResponse.json({
      success: true,
      dry_run: data.dry_run,
      pending_total: pendingTotal,
      processed: rows.length,
      updated,
      skipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка геокодинга мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
