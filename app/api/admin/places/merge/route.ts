/**
 * POST /api/admin/places/merge
 *
 * Мягкое слияние дублей places, подтверждённое админом вручную (кандидатов
 * даёт GET /api/admin/places/duplicates). НЕ удаляет строки — помечает
 * mergeIds как merged_into_id=keepId.
 *
 * Автоматически переносится только то, что безопасно переносить без знания
 * полной схемы:
 *  - фото (ai_route_images, keyed by ark_id) — если у keep его ещё нет;
 *  - route_waypoints.place_id — перевешивается на keepId, конфликтующие
 *    (тот же маршрут уже привязан к keep) дубли-waypoint'ы удаляются.
 *
 * location_safety_profile/location_real_time_status НЕ переносятся
 * автоматически — на кону safety-данные, а не вся структура этих таблиц
 * точно известна из кода. Если у объединяемой записи есть свой
 * safety-профиль, ответ явно предупреждает об этом для ручной проверки.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MergeSchema = z.object({
  keepId: z.string().regex(UUID_RE, 'keepId должен быть UUID'),
  mergeIds: z.array(z.string().regex(UUID_RE, 'mergeIds должны быть UUID')).min(1).max(10),
}).refine(v => !v.mergeIds.includes(v.keepId), { message: 'keepId не может быть в mergeIds' });

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }

  const parsed = MergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 });
  }
  const { keepId, mergeIds } = parsed.data;

  const keepRow = await pool.query<{ id: string; ark_id: string | null; merged_into_id: string | null }>(
    `SELECT id, ark_id, merged_into_id FROM places WHERE id = $1 LIMIT 1`,
    [keepId],
  );
  if (keepRow.rows.length === 0) {
    return NextResponse.json({ error: 'keepId не найден' }, { status: 404 });
  }
  if (keepRow.rows[0]!.merged_into_id) {
    return NextResponse.json({ error: 'keepId сам является объединённым дублем — выберите каноническую запись' }, { status: 409 });
  }
  const keepArkId = keepRow.rows[0]!.ark_id;

  const warnings: string[] = [];
  const merged: string[] = [];

  try {
    await transaction(async (client) => {
      for (const mergeId of mergeIds) {
        const mergeRow = await client.query<{ id: string; name: string; ark_id: string | null; merged_into_id: string | null }>(
          `SELECT id, name, ark_id, merged_into_id FROM places WHERE id = $1 LIMIT 1`,
          [mergeId],
        );
        if (mergeRow.rows.length === 0) {
          warnings.push(`${mergeId}: не найден, пропущен`);
          continue;
        }
        const row = mergeRow.rows[0]!;
        if (row.merged_into_id) {
          warnings.push(`${row.name}: уже объединён ранее, пропущен`);
          continue;
        }

        // Фото: копируем, только если у keep его ещё нет.
        if (keepArkId && row.ark_id) {
          await client.query(
            `INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height)
             SELECT $1, image_data, mime_type, prompt, model, width, height
             FROM ai_route_images WHERE route_id = $2
             ON CONFLICT (route_id) DO NOTHING`,
            [keepArkId, row.ark_id],
          );
        }

        // route_waypoints: перевесить на keepId там, где нет конфликта (тот же route_id
        // уже привязан к keep) — а конфликтующие дубли-waypoint'ы удалить (keep уже
        // связан с этим маршрутом, второй waypoint для того же route_id избыточен).
        await client.query(
          `UPDATE route_waypoints rw
           SET place_id = $1
           WHERE rw.place_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM route_waypoints rw2
               WHERE rw2.route_id = rw.route_id AND rw2.place_id = $1
             )`,
          [keepId, mergeId],
        );
        await client.query(`DELETE FROM route_waypoints WHERE place_id = $1`, [mergeId]);

        // Safety-профиль НЕ переносим автоматически — только предупреждаем.
        if (row.ark_id) {
          const safety = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM location_safety_profile WHERE agent_route_id = $1) AS exists`,
            [row.ark_id],
          );
          if (safety.rows[0]?.exists) {
            warnings.push(`${row.name}: есть свой safety-профиль — не перенесён автоматически, проверьте вручную`);
          }
        }

        await client.query(
          `UPDATE places SET merged_into_id = $1, merged_at = NOW() WHERE id = $2`,
          [keepId, mergeId],
        );
        merged.push(row.name);
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Слияние не выполнено: ${err instanceof Error ? err.message : 'неизвестная ошибка'}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, keepId, merged, warnings });
}
