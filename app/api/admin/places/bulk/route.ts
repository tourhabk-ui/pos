/**
 * POST /api/admin/places/bulk
 * Массовое действие над местами (bulk-чистилка для владельца):
 *   { ids: string[], action: 'hide' | 'unhide' | 'delete' }
 *
 * hide/unhide — переключают is_visible (обратимо, безопасно, дефолт для чистки).
 * delete — жёсткое удаление с каскадной чисткой зависимых строк (необратимо).
 * Только админ. За раз — до 500 id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f-]{36}$/i;

const BodySchema = z.object({
  ids: z.array(z.string().regex(UUID_RE, 'Неверный ID места')).min(1).max(500),
  action: z.enum(['hide', 'unhide', 'delete']),
});

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { ids, action } = body;

  try {
    if (action === 'hide' || action === 'unhide') {
      const visible = action === 'unhide';
      const res = await pool.query(
        `UPDATE places SET is_visible = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
        [visible, ids],
      );
      return NextResponse.json({ ok: true, action, affected: res.rowCount ?? 0 });
    }

    // delete — каскадная чистка зависимых строк одним набором в транзакции.
    let affected = 0;
    await transaction(async (client) => {
      // ark_id удаляемых мест — для чистки таблиц, ссылающихся по ark_id.
      const arkRes = await client.query<{ ark_id: string | null }>(
        `SELECT ark_id FROM places WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const arkIds = arkRes.rows.map(r => r.ark_id).filter((a): a is string => !!a);

      if (arkIds.length > 0) {
        await client.query(`DELETE FROM ai_route_images WHERE route_id = ANY($1::uuid[])`, [arkIds]);
        await client.query(`DELETE FROM location_safety_profile WHERE agent_route_id = ANY($1::uuid[])`, [arkIds]);
        await client.query(`DELETE FROM location_real_time_status WHERE agent_route_id = ANY($1::uuid[])`, [arkIds]);
      }
      await client.query(`DELETE FROM route_waypoints WHERE place_id = ANY($1::uuid[])`, [ids]);
      // Осиротить merged_into_id-ссылки на удаляемые места (иначе FK-сирота).
      await client.query(
        `UPDATE places SET merged_into_id = NULL, merged_at = NULL WHERE merged_into_id = ANY($1::uuid[])`,
        [ids],
      );
      const del = await client.query(`DELETE FROM places WHERE id = ANY($1::uuid[])`, [ids]);
      affected = del.rowCount ?? 0;
    });

    return NextResponse.json({ ok: true, action, affected });
  } catch (err) {
    return NextResponse.json(
      { error: `Массовое действие не выполнено: ${err instanceof Error ? err.message : 'неизвестная ошибка'}` },
      { status: 500 },
    );
  }
}
