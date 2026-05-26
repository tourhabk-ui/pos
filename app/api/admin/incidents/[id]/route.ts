import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const ALLOWED_FIELDS = new Set([
  'slug', 'incident_date', 'title', 'location_name', 'location_type',
  'casualties', 'injured', 'description', 'cause', 'lessons',
  'mchs_involved', 'source_url',
]);

const PatchSchema = z.object({
  slug:          z.string().min(3).max(120).regex(/^[a-z0-9-]+$/).optional(),
  incident_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  title:         z.string().min(5).max(500).optional(),
  location_name: z.string().min(2).max(300).optional(),
  location_type: z.enum(['volcano', 'river', 'trail', 'sea', 'glacier']).optional(),
  casualties:    z.number().int().min(0).optional(),
  injured:       z.number().int().min(0).optional(),
  description:   z.string().min(10).optional(),
  cause:         z.string().min(10).optional(),
  lessons:       z.array(z.string().min(5)).min(1).max(10).optional(),
  mchs_involved: z.boolean().optional(),
  source_url:    z.string().url().nullable().optional(),
});

interface Props {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Props) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Неверный id' }, { status: 400 });
  }

  const body: unknown = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues }, { status: 400 });
  }

  const d = parsed.data;
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(d)) {
    if (val !== undefined && ALLOWED_FIELDS.has(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (fields.length === 0) {
    return NextResponse.json({ success: false, error: 'Нет полей для обновления' }, { status: 400 });
  }

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE tourist_incidents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (!rows[0]) {
    return NextResponse.json({ success: false, error: 'Не найдено' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: rows[0] });
}

export async function DELETE(req: NextRequest, { params }: Props) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Неверный id' }, { status: 400 });
  }

  const { rowCount } = await pool.query(
    `DELETE FROM tourist_incidents WHERE id = $1`, [id]
  );

  if (!rowCount) {
    return NextResponse.json({ success: false, error: 'Не найдено' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
