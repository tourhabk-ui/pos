/**
 * GET /api/parks
 * Публичный. Список активных природных парков (справочник parks, migration 712).
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { rows } = await pool.query<{
      slug: string;
      display_name: string;
      description: string | null;
      zone: string | null;
    }>(
      `SELECT slug, display_name, description, zone
       FROM parks
       WHERE is_active = true
       ORDER BY display_name`
    );

    return NextResponse.json({
      success: true,
      parks: rows.map(r => ({
        slug: r.slug,
        displayName: r.display_name,
        description: r.description,
        zone: r.zone,
      })),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка загрузки парков' }, { status: 500 });
  }
}
