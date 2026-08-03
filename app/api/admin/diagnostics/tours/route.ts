/**
 * GET /api/admin/diagnostics/tours  (admin-only, только чтение)
 *
 * Список ВСЕХ туров с ключевым состоянием — чтобы видеть реальную картину на
 * проде (дубли, публикация, категория, обрывки описания), а не гадать. Помогает
 * ловить: тур не создан / не опубликован / дубль по названию / выдуманное
 * описание (§8).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { rows } = await pool.query(`
      SELECT ot.id, ot.title, ot.activity_type,
             ot.is_published, ot.is_active, ot.deleted_at,
             ot.base_price::text,
             LEFT(COALESCE(ot.short_description, ''), 120) AS short_description,
             LEFT(COALESCE(ot.description, ''), 160)       AS description_head,
             COALESCE(array_length(ot.photos, 1), 0)       AS photos,
             p.name AS operator
        FROM operator_tours ot
        LEFT JOIN partners p ON p.id = ot.operator_id
       ORDER BY ot.id
    `);

    const visible = rows.filter(
      (r) => r.is_active === true && r.is_published === true && r.deleted_at === null,
    ).length;

    // Дубли по нормализованному названию — сигнал каши в данных
    const byTitle = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.title ?? '').trim().toLowerCase();
      byTitle.set(k, (byTitle.get(k) ?? 0) + 1);
    }
    const duplicates = [...byTitle.entries()].filter(([, n]) => n > 1).map(([t, n]) => ({ title: t, count: n }));

    return NextResponse.json({
      total: rows.length,
      visible_in_catalog: visible,
      duplicates,
      tours: rows,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
