/**
 * Операторы, которых мы заметили и хотим позвать (см. миграцию 816).
 *
 * Это заметка отдела продаж, а не сущность платформы: туристу она не видна
 * никогда. Здесь только чтение и смена статуса — заводить партнёра из
 * заметки автоматически нельзя, договорённость подтверждает человек.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { safeMsg } from '@/lib/errors/sanitize';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

interface ProspectRow {
  id: string;
  name: string;
  source: string | null;
  website: string | null;
  details: Record<string, unknown>;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const PATCH_STATUSES = ['new', 'contacted', 'agreed', 'declined'] as const;

const UpdateSchema = z.object({
  id: z.string().min(1, 'ID обязателен'),
  status: z.enum(PATCH_STATUSES, { message: 'Недопустимый статус' }),
  notes: z.string().max(4000).optional(),
});

// GET /api/admin/partner-prospects — список
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await query<ProspectRow>(
      `SELECT id::text, name, source, website, details, notes, status,
              created_at::text, updated_at::text
         FROM partner_prospects
        ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,
                 created_at DESC`,
      [],
    );
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}

// PATCH /api/admin/partner-prospects — статус после разговора
export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const parsed = UpdateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
        { status: 400 },
      );
    }
    const { id, status, notes } = parsed.data;

    const result = await query(
      `UPDATE partner_prospects
          SET status = $2,
              notes = COALESCE($3, notes),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [id, status, notes ?? null],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Запись не найдена' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}
