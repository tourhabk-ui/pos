import { NextRequest } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

const BodySchema = z.object({
  is_ok:      z.boolean(),
  conditions: z.array(z.string().max(50)).max(10).default([]),
  note:       z.string().max(300).optional(),
  lat:        z.number().min(-90).max(90).optional(),
  lng:        z.number().min(-180).max(180).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: placeId } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(placeId)) {
    return Response.json({ error: 'Некорректный идентификатор места' }, { status: 400 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Ошибка валидации', details: parsed.error.flatten() }, { status: 422 });
  }

  const { is_ok, conditions, note, lat, lng } = parsed.data;

  // Verify place exists
  const { rowCount } = await pool.query('SELECT 1 FROM places WHERE id = $1', [placeId]);
  if (!rowCount) {
    return Response.json({ error: 'Место не найдено' }, { status: 404 });
  }

  await pool.query(
    `INSERT INTO place_safety_reports (place_id, is_ok, conditions, note, reporter_lat, reporter_lng)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [placeId, is_ok, conditions, note ?? null, lat ?? null, lng ?? null],
  );

  return Response.json({ ok: true });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: placeId } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(placeId)) {
    return Response.json({ error: 'Некорректный идентификатор места' }, { status: 400 });
  }

  const { rows } = await pool.query<{
    id: string;
    is_ok: boolean;
    conditions: string[];
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, is_ok, conditions, note, created_at
     FROM place_safety_reports
     WHERE place_id = $1
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 20`,
    [placeId],
  );

  return Response.json({ reports: rows });
}
