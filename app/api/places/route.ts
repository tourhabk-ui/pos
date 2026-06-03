/**
 * GET /api/places
 * Поиск мест по названию — для автокомплита в инструментах.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q:     z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  type:  z.string().max(60).optional(),
});

export async function GET(request: NextRequest) {
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры' }, { status: 400 });
  }

  const { q, limit, type } = parsed.data;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(p.name ILIKE $${idx} OR p.description ILIKE $${idx + 1})`);
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  if (type) {
    conditions.push(`p.location_type = $${idx}`);
    params.push(type);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query(
      `SELECT
        p.id, p.ark_id, p.name, p.location_type,
        p.lat, p.lng, p.description
       FROM places p
       ${where}
       ORDER BY p.name ASC
       LIMIT $${idx}`,
      [...params, limit]
    );

    const response = NextResponse.json({
      success: true,
      data: result.rows.map(r => ({
        id:           r.id as string,
        arkId:        r.ark_id as string,
        name:         r.name as string,
        locationType: (r.location_type as string | null) ?? null,
        lat:          r.lat != null ? parseFloat(r.lat as string) : null,
        lng:          r.lng != null ? parseFloat(r.lng as string) : null,
        description:  ((r.description as string | null) ?? '').slice(0, 120),
      })),
    });
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return response;
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка поиска' }, { status: 500 });
  }
}
