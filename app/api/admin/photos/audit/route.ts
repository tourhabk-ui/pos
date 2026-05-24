import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { auditPhotoBatch } from '@/lib/agents/photo-auditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BodySchema = z.object({
  batchSize: z.number().int().min(1).max(100).optional(),
});

interface CountRow {
  remaining: string;
}

export async function POST(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Неверные параметры запроса' },
      { status: 400 },
    );
  }

  const batchSize = parsed.data.batchSize ?? 10;

  try {
    const result = await auditPhotoBatch(batchSize);

    const { rows } = await pool.query<CountRow>(
      `SELECT COUNT(*)::text AS remaining
       FROM ai_route_images
       WHERE photo_verified IS NULL`,
    );

    const remaining = parseInt(rows[0]?.remaining ?? '0', 10);

    return NextResponse.json({ ...result, remaining });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка аудита фото' },
      { status: 500 },
    );
  }
}
