/**
 * DELETE /api/admin/places/[id]
 *
 * Жёсткое удаление места — но ТОЛЬКО если оно уже помечено как дубль через
 * POST /api/admin/places/merge (merged_into_id IS NOT NULL). Живую,
 * непроверенную запись это удалить не даст — сначала обязателен шаг
 * ручного подтверждения слияния.
 *
 * Перед удалением чистит зависимые строки:
 *  - ai_route_images, location_safety_profile, location_real_time_status
 *    (keyed by ark_id)
 *  - route_waypoints (keyed by place_id, на всякий случай — после merge
 *    их обычно уже нет)
 *
 * Если у записи остался непереданный safety-профиль (POST /merge не
 * переносит его автоматически и явно предупреждает об этом), удаление
 * блокируется, пока не передан ?force=true — чтобы не потерять safety-данные
 * молча.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ id: string }> }

export async function DELETE(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
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

  if (!place.merged_into_id) {
    return NextResponse.json(
      { error: 'Удалять можно только записи, уже помеченные как дубль через слияние (POST /api/admin/places/merge)' },
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
          error: `У "${place.name}" есть непроверенный safety-профиль, который не был перенесён при слиянии. Проверьте его вручную, затем повторите запрос с ?force=true.`,
        },
        { status: 409 },
      );
    }
  }

  try {
    await transaction(async (client) => {
      if (place.ark_id) {
        await client.query(`DELETE FROM ai_route_images WHERE route_id = $1`, [place.ark_id]);
        await client.query(`DELETE FROM location_safety_profile WHERE agent_route_id = $1`, [place.ark_id]);
        await client.query(`DELETE FROM location_real_time_status WHERE agent_route_id = $1`, [place.ark_id]);
      }
      await client.query(`DELETE FROM route_waypoints WHERE place_id = $1`, [id]);
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
