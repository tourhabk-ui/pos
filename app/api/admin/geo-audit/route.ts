/**
 * GET /api/admin/geo-audit
 * Временный диагностический endpoint для аудита геолокаций.
 * Защищён ADMIN_AUDIT_TOKEN. Удалить после диагностики.
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token || token !== process.env.ADMIN_AUDIT_TOKEN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [placeholders, outOfBbox, migrations, duplicates, routesNoCoords] = await Promise.all([
    // 1. Точки с placeholder координатами
    query(`
      SELECT id, name, location_type, is_visible,
             ROUND(lat::numeric,4) as lat, ROUND(lng::numeric,4) as lng
      FROM places
      WHERE ROUND(lat::numeric,4) = 53.0444
        AND ROUND(lng::numeric,4) = 158.6483
      ORDER BY is_visible DESC, name
      LIMIT 50
    `),

    // 2. Точки вне bbox Камчатки
    query(`
      SELECT id, name, lat, lng, is_visible, source_name
      FROM places
      WHERE lat::float NOT BETWEEN 50 AND 62
         OR lng::float NOT BETWEEN 154 AND 170
      ORDER BY is_visible DESC
      LIMIT 50
    `),

    // 3. Применились ли миграции 673-674
    query(`
      SELECT name, applied_at FROM _migrations
      WHERE name LIKE '67%'
      ORDER BY name
    `),

    // 4. Дубли координат (много точек в одном месте)
    query(`
      SELECT ROUND(lat::numeric,3) as la, ROUND(lng::numeric,3) as ln,
             COUNT(*) as cnt, array_agg(name ORDER BY name) as names
      FROM places
      WHERE is_visible = true
      GROUP BY ROUND(lat::numeric,3), ROUND(lng::numeric,3)
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 20
    `),

    // 5. Маршруты без координат
    query(`
      SELECT id, title, source_name, created_at
      FROM kamchatka_routes
      WHERE (lat IS NULL OR lng IS NULL)
        AND is_visible = true
      ORDER BY created_at DESC
      LIMIT 30
    `),
  ]);

  return NextResponse.json({
    placeholders: {
      total: placeholders.rows.length,
      visible: placeholders.rows.filter((r: Record<string, unknown>) => r.is_visible).length,
      hidden: placeholders.rows.filter((r: Record<string, unknown>) => !r.is_visible).length,
      rows: placeholders.rows,
    },
    outOfBbox: {
      total: outOfBbox.rows.length,
      rows: outOfBbox.rows,
    },
    migrations: migrations.rows,
    duplicateCoords: duplicates.rows,
    routesWithoutCoords: {
      total: routesNoCoords.rows.length,
      rows: routesNoCoords.rows,
    },
  });
}
