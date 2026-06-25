import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  message_id: z.string().min(1),
  user_id:    z.string().optional(),
  query:      z.string().optional(),
  answer:     z.string().optional(),
  rating:     z.union([z.literal(1), z.literal(-1)]),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { message_id, user_id, query, answer, rating } = parsed.data;

  await pool.query(
    `INSERT INTO rag_feedback (message_id, user_id, query, answer, rating, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (message_id, user_id)
     DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()`,
    [message_id, user_id ?? null, query ?? null, answer ?? null, rating],
  );

  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(Math.max(parseInt(searchParams.get('days') ?? '30', 10), 1), 365);

  const { rows } = await pool.query<{ total: string; positive: string }>(
    `SELECT
       COUNT(*)::text                                    AS total,
       COUNT(*) FILTER (WHERE rating = 1)::text         AS positive
     FROM rag_feedback
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`,
    [days],
  );

  const total    = Number(rows[0]?.total    ?? 0);
  const positive = Number(rows[0]?.positive ?? 0);

  return NextResponse.json({
    period_days:    days,
    total,
    positive_count: positive,
    negative_count: total - positive,
    positive_ratio: total > 0 ? Math.round((positive / total) * 100) / 100 : null,
  });
}
