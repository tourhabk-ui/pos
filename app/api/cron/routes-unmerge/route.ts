/**
 * POST /api/cron/routes-unmerge — откат мягкого слияния маршрутов: обнуляет
 * merged_into_id/merged_at у перечисленных id, возвращая записи на витрину.
 *
 * Bearer CRON_SECRET. Body: { ids: string[] } — id merge-стороны.
 *
 * Как и у мест: перенесённые waypoints/туры/геометрия обратно НЕ едут —
 * откат возвращает только саму запись из merged-состояния. Для ошибочной
 * пары этого достаточно, а полный распил делается руками по данным
 * конкретного случая.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  ids: z.array(z.string().min(8).max(64)).min(1).max(100),
});

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
    const { rows } = await pool.query<{ title: string }>(
      `UPDATE kamchatka_routes
       SET merged_into_id = NULL, merged_at = NULL
       WHERE id::text = ANY($1) AND merged_into_id IS NOT NULL
       RETURNING title`,
      [data.ids],
    );
    return NextResponse.json({
      success: true,
      unmerged_count: rows.length,
      unmerged: rows.map(r => r.title),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка отката';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
