/**
 * GET /api/admin/places/cleanup?q=&filter=&type=&page=&limit=
 *
 * Список мест для bulk-чистилки владельца: с флагами качества и фильтрами.
 * filter: all (дефолт) | no_photo | hidden | garbage
 * garbage = «мусорное имя»: слишком длинное (тур/статья), многосентенсное
 *   («… . …») или generic-однословное («Вершина», «Скала», «Место»).
 * Только админ. Пагинация; мусор — сверху.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

// Generic-однословные имена — почти всегда мусор (реальные точки имеют собственные
// имена: «Ксудач», «Опала»). Нормализуем: lower + trim.
const GENERIC_NAMES = [
  'вершина', 'скала', 'место', 'гора', 'смотровая', 'точка', 'водопад',
  'озеро', 'река', 'бухта', 'мыс', 'сопка', 'вулкан', 'источник', 'пляж',
];

// SQL-выражение «мусорное имя» — одно, чтобы флаг и фильтр совпадали.
const GARBAGE_SQL = `(
  char_length(p.name) > 55
  OR p.name LIKE '%. %'
  OR btrim(lower(p.name)) = ANY($GENERIC$)
)`;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const sp = request.nextUrl.searchParams;
  const q = sp.get('q')?.trim() ?? '';
  const filter = sp.get('filter') ?? 'all';
  const type = sp.get('type')?.trim() ?? '';
  const page = Math.max(parseInt(sp.get('page') ?? '1', 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  const conds: string[] = ['p.merged_into_id IS NULL'];
  const params: unknown[] = [];
  // $1 всегда — массив generic-имён (для GARBAGE_SQL).
  params.push(GENERIC_NAMES);
  const garbageSql = GARBAGE_SQL.replace('$GENERIC$', `$${params.length}`);

  if (q) { params.push(`%${q}%`); conds.push(`p.name ILIKE $${params.length}`); }
  if (type) { params.push(type); conds.push(`p.location_type = $${params.length}`); }
  if (filter === 'no_photo') conds.push('ari.route_id IS NULL');
  else if (filter === 'hidden') conds.push('p.is_visible = FALSE');
  else if (filter === 'garbage') conds.push(garbageSql);

  const where = `WHERE ${conds.join(' AND ')}`;
  params.push(limit); const limitP = `$${params.length}`;
  params.push(offset); const offsetP = `$${params.length}`;

  try {
    const result = await pool.query<{
      id: string; ark_id: string | null; name: string; location_type: string | null;
      is_visible: boolean; lat: number | null; lng: number | null;
      desc_len: number; has_photo: boolean; garbage: boolean; total: number;
    }>(
      `SELECT
         p.id, p.ark_id, p.name, p.location_type, p.is_visible,
         p.lat::float AS lat, p.lng::float AS lng,
         length(COALESCE(p.description, ''))::int AS desc_len,
         (ari.route_id IS NOT NULL) AS has_photo,
         ${garbageSql} AS garbage,
         COUNT(*) OVER()::int AS total
       FROM places p
       LEFT JOIN ai_route_images ari ON ari.route_id = p.ark_id
       ${where}
       ORDER BY ${garbageSql} DESC, (ari.route_id IS NOT NULL), p.name ASC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );

    const total = result.rows[0]?.total ?? 0;
    return NextResponse.json({
      items: result.rows.map(r => ({
        id: r.id,
        arkId: r.ark_id,
        name: r.name,
        locationType: r.location_type,
        isVisible: r.is_visible,
        lat: r.lat, lng: r.lng,
        descLen: r.desc_len,
        hasPhoto: r.has_photo,
        photoUrl: r.has_photo && r.ark_id ? `/api/images/route/${r.ark_id}` : null,
        garbageName: r.garbage,
      })),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Не удалось получить список: ${err instanceof Error ? err.message : 'ошибка'}` },
      { status: 500 },
    );
  }
}
