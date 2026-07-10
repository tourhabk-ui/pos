/**
 * Полный админ-доступ к месту (places):
 *   GET    — все редактируемые поля для формы редактора;
 *   PATCH  — правка полей (name, description, lat, lng, location_type, is_visible);
 *   DELETE — жёсткое удаление с каскадной чисткой зависимых строк.
 *
 * DELETE по умолчанию разрешён только для уже-слитых дублей (merged_into_id
 * IS NOT NULL). Для полного доступа владельца — ?force=true удаляет ЛЮБОЕ
 * место (в т.ч. живое и с safety-профилем). force обязателен и для места с
 * непереданным safety-профилем — чтобы не потерять safety-данные молча.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PlaceRow {
  id: string; ark_id: string | null; name: string; description: string | null;
  lat: number | null; lng: number | null; location_type: string | null;
  is_visible: boolean | null; source_name: string | null; source_url: string | null;
  merged_into_id: string | null; has_photo: boolean;
}

export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });

  const { rows } = await pool.query<PlaceRow>(
    `SELECT p.id, p.ark_id, p.name, p.description, p.lat, p.lng, p.location_type,
            p.is_visible, p.source_name, p.source_url, p.merged_into_id,
            (ari.route_id IS NOT NULL) AS has_photo
     FROM places p
     LEFT JOIN ai_route_images ari ON ari.route_id = p.ark_id
     WHERE p.id = $1 LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });
  const p = rows[0]!;
  return NextResponse.json({
    id: p.id, arkId: p.ark_id, name: p.name, description: p.description,
    lat: p.lat, lng: p.lng, locationType: p.location_type, isVisible: p.is_visible,
    sourceName: p.source_name, sourceUrl: p.source_url, mergedIntoId: p.merged_into_id,
    hasPhoto: p.has_photo,
  });
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20000).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  locationType: z.string().trim().max(50).nullish(),
  isVisible: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Нет полей для обновления' });

const FIELD_COLUMN: Record<string, string> = {
  name: 'name', description: 'description', lat: 'lat', lng: 'lng',
  locationType: 'location_type', isVisible: 'is_visible',
};

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });

  let data: z.infer<typeof PatchSchema>;
  try {
    data = PatchSchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(FIELD_COLUMN)) {
    if (key in data) {
      values.push((data as Record<string, unknown>)[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  values.push(id);

  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `UPDATE places SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id, name`,
      values,
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });
    return NextResponse.json({ ok: true, id: rows[0]!.id, name: rows[0]!.name });
  } catch (err) {
    return NextResponse.json(
      { error: `Обновление не выполнено: ${err instanceof Error ? err.message : 'неизвестная ошибка'}` },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  const force = request.nextUrl.searchParams.get('force') === 'true';

  const row = await pool.query<{ id: string; name: string; ark_id: string | null; merged_into_id: string | null }>(
    `SELECT id, name, ark_id, merged_into_id FROM places WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (row.rows.length === 0) {
    return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });
  }
  const place = row.rows[0]!;

  // По умолчанию — только слитые дубли. force=true снимает ограничение (полный
  // доступ владельца), но требует явного подтверждения на стороне UI.
  if (!place.merged_into_id && !force) {
    return NextResponse.json(
      { error: 'Живое место удаляется только с подтверждением (?force=true). Обычный путь — слить как дубль через merge.' },
      { status: 409 },
    );
  }

  if (place.ark_id && !force) {
    const safety = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM location_safety_profile WHERE agent_route_id = $1) AS exists`,
      [place.ark_id],
    );
    if (safety.rows[0]?.exists) {
      return NextResponse.json(
        {
          error: `У "${place.name}" есть непроверенный safety-профиль. Проверьте его вручную, затем повторите с ?force=true.`,
        },
        { status: 409 },
      );
    }
  }

  try {
    await transaction(async (client) => {
      // Перевесить waypoints и туры, ссылающиеся на место? У places нет FK от
      // operator_tours (те на kamchatka_routes). Чистим только зависимые от места.
      if (place.ark_id) {
        await client.query(`DELETE FROM ai_route_images WHERE route_id = $1`, [place.ark_id]);
        await client.query(`DELETE FROM location_safety_profile WHERE agent_route_id = $1`, [place.ark_id]);
        await client.query(`DELETE FROM location_real_time_status WHERE agent_route_id = $1`, [place.ark_id]);
      }
      await client.query(`DELETE FROM route_waypoints WHERE place_id = $1`, [id]);
      // Снять ссылки merged_into_id у мест, слитых в это (иначе FK-сирота).
      await client.query(`UPDATE places SET merged_into_id = NULL, merged_at = NULL WHERE merged_into_id = $1`, [id]);
      await client.query(`DELETE FROM places WHERE id = $1`, [id]);
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Удаление не выполнено: ${err instanceof Error ? err.message : 'неизвестная ошибка'}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id, name: place.name });
}
