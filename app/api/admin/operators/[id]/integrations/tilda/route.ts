/**
 * Ключи Tilda API партнёра (решение владельца 06.08: ключи у Партнёра в базе,
 * не в env — партнёров много).
 *
 * GET    — настроено ли; ключи только маской («····f1a2»), секрет целиком
 *          не возвращается никогда и никому.
 * PUT    — сохранить/заменить пару ключей.
 * DELETE — удалить интеграцию.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import {
  getTildaCredentials,
  saveTildaCredentials,
  deleteTildaCredentials,
  maskKey,
} from '@/lib/integrations/tilda';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const KeySchema = z.string().regex(/^[a-z0-9]{10,64}$/i, 'Ключ Tilda — 10-64 символа, буквы и цифры');
const Schema = z.object({
  public_key: KeySchema,
  secret_key: KeySchema,
});

async function partnerExists(id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM partners WHERE id = $1`, [id]);
  return rows.length > 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const creds = await getTildaCredentials(id);
  return NextResponse.json({
    success: true,
    configured: creds !== null,
    public_key_masked: creds ? maskKey(creds.public_key) : null,
    secret_key_masked: creds ? maskKey(creds.secret_key) : null,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!(await partnerExists(id))) {
    return NextResponse.json({ error: 'Партнёр не найден' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Неверные ключи' }, { status: 400 });
  }

  await saveTildaCredentials(id, parsed.data);
  return NextResponse.json({
    success: true,
    configured: true,
    public_key_masked: maskKey(parsed.data.public_key),
    secret_key_masked: maskKey(parsed.data.secret_key),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const deleted = await deleteTildaCredentials(id);
  if (!deleted) {
    return NextResponse.json({ error: 'Интеграция не настроена' }, { status: 404 });
  }
  return NextResponse.json({ success: true, configured: false });
}
