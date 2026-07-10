/**
 * POST /api/cron/places-unmerge — откат мягкого слияния мест: обнуляет
 * merged_into_id/merged_at у перечисленных по имени мест, возвращая их в
 * листинги. Нужен для отката ошибочных авто-дедуп-слияний (places-dedup).
 *
 * Bearer CRON_SECRET. Body: { names: string[] } — точные имена merge-стороны.
 *
 * Замечание: слияние перенесло фото (ON CONFLICT DO NOTHING) и waypoints на
 * keep. Un-merge их обратно НЕ тянет — только возвращает саму запись из
 * merged-состояния. Для ошибочных пар этого достаточно (у merge-стороны фото/
 * waypoints обычно и не было).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  names: z.array(z.string().min(1).max(200)).min(1).max(100),
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
    const { rows } = await pool.query<{ name: string }>(
      `UPDATE places
       SET merged_into_id = NULL, merged_at = NULL
       WHERE name = ANY($1) AND merged_into_id IS NOT NULL
       RETURNING name`,
      [data.names],
    );
    const unmerged = rows.map((r) => r.name);
    const notFound = data.names.filter((n) => !unmerged.includes(n));
    return NextResponse.json({ success: true, unmerged_count: unmerged.length, unmerged, not_found: notFound });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка отката слияния';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
