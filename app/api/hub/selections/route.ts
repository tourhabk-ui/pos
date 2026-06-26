/**
 * GET  /api/hub/selections  — список подборок оператора (с engagement stats)
 * POST /api/hub/selections  — создать подборку
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

function generateCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const CreateSchema = z.object({
  title:           z.string().max(200).optional(),
  client_name:     z.string().max(100).optional(),
  client_phone:    z.string().max(30).optional(),
  client_telegram: z.string().max(100).optional(),
  tour_ids:        z.array(z.number().positive()).min(1).max(20),
  notes:           z.record(z.string(), z.string().max(500)).optional(),
  expires_days:    z.number().min(1).max(90).default(30),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const operatorRow = await pool.query<{ id: string }>(
    `SELECT id FROM partners WHERE user_id = $1 LIMIT 1`,
    [auth.userId],
  );
  const operatorId = operatorRow.rows[0]?.id;

  // Admin sees all; operator sees own
  const isAdmin = auth.role === 'admin';

  const { rows } = await pool.query(
    `SELECT
       s.id, s.code, s.title, s.client_name, s.client_phone, s.client_telegram,
       s.created_via, s.expires_at, s.created_at,
       COUNT(DISTINCT si.id)::int                                AS tour_count,
       COUNT(DISTINCT CASE WHEN e.event_type = 'open'       THEN e.id END)::int AS opens,
       COUNT(DISTINCT CASE WHEN e.event_type = 'tour_view'  THEN e.id END)::int AS tour_views,
       COUNT(DISTINCT CASE WHEN e.event_type = 'book_click' THEN e.id END)::int AS book_clicks,
       MAX(e.created_at)                                          AS last_activity
     FROM tour_selections s
     LEFT JOIN tour_selection_items si ON si.selection_id = s.id
     LEFT JOIN tour_selection_events e  ON e.selection_id = s.id
     WHERE ($1 OR s.operator_id = $2)
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
     GROUP BY s.id
     ORDER BY s.created_at DESC
     LIMIT 50`,
    [isAdmin, operatorId ?? null],
  );

  return NextResponse.json({ selections: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const data = parsed.data;

  const operatorRow = await pool.query<{ id: string }>(
    `SELECT id FROM partners WHERE user_id = $1 LIMIT 1`,
    [auth.userId],
  );
  const operatorId = operatorRow.rows[0]?.id ?? null;

  // Verify all tour_ids belong to this operator (or admin bypasses)
  if (auth.role !== 'admin' && operatorId) {
    const check = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM operator_tours
       WHERE id = ANY($1::int[]) AND operator_id = $2 AND deleted_at IS NULL`,
      [data.tour_ids, operatorId],
    );
    if (parseInt(check.rows[0]?.cnt ?? '0', 10) !== data.tour_ids.length) {
      return NextResponse.json({ error: 'Один или несколько туров не найдены' }, { status: 403 });
    }
  }

  // Generate unique code
  let code = generateCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = await pool.query('SELECT 1 FROM tour_selections WHERE code = $1', [code]);
    if (exists.rows.length === 0) break;
    code = generateCode();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + data.expires_days);

    const sel = await client.query<{ id: string }>(
      `INSERT INTO tour_selections (code, title, client_name, client_phone, client_telegram, operator_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [code, data.title ?? null, data.client_name ?? null, data.client_phone ?? null,
       data.client_telegram ?? null, operatorId, auth.userId, expiresAt],
    );
    const selectionId = sel.rows[0]!.id;

    for (let i = 0; i < data.tour_ids.length; i++) {
      const tourId = data.tour_ids[i]!;
      const note = data.notes?.[String(tourId)] ?? null;
      await client.query(
        `INSERT INTO tour_selection_items (selection_id, operator_tour_id, position, note)
         VALUES ($1, $2, $3, $4)`,
        [selectionId, tourId, i, note],
      );
    }

    await client.query('COMMIT');

    return NextResponse.json({
      id: selectionId,
      code,
      url: `/p/${code}`,
      expires_at: expiresAt,
    }, { status: 201 });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('selection create error:', err);
    return NextResponse.json({ error: 'Не удалось создать подборку' }, { status: 500 });
  } finally {
    client.release();
  }
}
