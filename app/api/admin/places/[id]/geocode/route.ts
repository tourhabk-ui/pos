/**
 * GET  /api/admin/places/[id]/geocode — предлагает координаты по названию места
 *      (Nominatim/OpenStreetMap), ничего не пишет в БД.
 * POST /api/admin/places/[id]/geocode — применяет lat/lng к месту (ручное
 *      подтверждение админом — тот же паттерн, что и duplicates/merge).
 *
 * Только для places с NULL lat/lng (issue: computePlacesQuality().missingCoordsIds) —
 * у существующей записи с реальными координатами перезаписывать нечего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { geocodeAddress, withinKamchatka } from '@/lib/services/routes/geocode';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ id: string }> }

async function findPlaceMissingCoords(id: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM places WHERE id = $1 AND (lat IS NULL OR lng IS NULL) LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  const place = await findPlaceMissingCoords(id);
  if (!place) {
    return NextResponse.json({ error: 'Место не найдено или координаты уже заполнены' }, { status: 404 });
  }

  const result = await geocodeAddress(`${place.name}, Камчатский край, Россия`);
  if (!result) {
    return NextResponse.json({ suggestion: null, warning: 'Nominatim не вернул результат' });
  }

  const inBounds = withinKamchatka(result.lat, result.lng);
  return NextResponse.json({
    suggestion: { lat: result.lat, lng: result.lng, displayName: result.displayName },
    source: result.source,
    out_of_bounds: !inBounds,
    warning: inBounds ? null : 'Координаты вне ожидаемых границ Камчатки — применить не получится (issue #290)',
  });
}

const ApplySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }

  const parsed = ApplySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 });
  }
  const { lat, lng } = parsed.data;

  // Вне bbox Камчатки — НЕ сохраняем (issue #290): координаты за пределами
  // края ломают офлайн-карту и SOS-позиционирование, «сохранено с warning»
  // было слишком мягко — мусор попадал в places. Проверка до похода в БД.
  if (!withinKamchatka(lat, lng)) {
    return NextResponse.json(
      {
        ok: false,
        out_of_bounds: true,
        error: 'Координаты вне границ Камчатки — не сохранено. Проверьте название места или укажите координаты вручную.',
      },
      { status: 422 },
    );
  }

  const place = await findPlaceMissingCoords(id);
  if (!place) {
    return NextResponse.json({ error: 'Место не найдено или координаты уже заполнены' }, { status: 404 });
  }

  await pool.query(`UPDATE places SET lat = $1, lng = $2 WHERE id = $3`, [lat, lng, id]);

  return NextResponse.json({ ok: true, id, lat, lng, out_of_bounds: false });
}
