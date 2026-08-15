/**
 * POST /api/cron/place-unlink — снять привязку места к маршруту.
 *
 * Откат для place-link: удаляет строки route_waypoints по поимённым парам.
 * Позиции остальных точек не пересчитываются — дырка в нумерации безвредна,
 * а пересборка чужого порядка опаснее её.
 *
 * Bearer CRON_SECRET. Body: { pairs: [{place, route}] (1..50) }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  pairs: z.array(z.object({
    place: z.string().min(8).max(64),
    route: z.string().min(8).max(64),
  })).min(1).max(50),
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
    const { rows } = await pool.query<{ title: string; name: string }>(
      `DELETE FROM route_waypoints rw
       USING unnest($1::text[], $2::text[]) AS t(place, route),
             kamchatka_routes r, places p
       WHERE r.id::text = t.route AND p.id::text = t.place
         AND rw.route_id = r.id AND rw.place_id = p.id
       RETURNING r.title, p.name`,
      [data.pairs.map(p => p.place), data.pairs.map(p => p.route)],
    );
    return NextResponse.json({
      success: true,
      unlinked_count: rows.length,
      unlinked: rows.map(r => `${r.name} ← ${r.title}`),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка отката привязки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
