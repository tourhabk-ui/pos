/**
 * POST /api/admin/operators/[id]/reset-link — ссылка сброса пароля для
 * аккаунта партнёра, выданная администратором.
 *
 * Зачем, когда есть форма «Забыли пароль?»: форма шлёт письмо, а SMTP на
 * платформе может быть не настроен, и письмо до оператора-в-поле доходит
 * хуже, чем сообщение в мессенджере. Администратор пересылает ссылку сам.
 *
 * Та же механика, что у формы (lib/auth/password-reset): хеш в базе,
 * одноразовость, срок — сутки (ADMIN_ISSUED_TTL_MS), issued_by — кто выдал.
 * Ссылка — это вход в чужой кабинет на один раз: только requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { issuePasswordResetToken, ADMIN_ISSUED_TTL_MS } from '@/lib/auth/password-reset';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const parsedId = IdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return NextResponse.json({ success: false, error: 'Неверный идентификатор партнёра' }, { status: 400 });
  }
  const id = parsedId.data;

  let row: { name: string; user_id: string | null } | undefined;
  try {
    ({ rows: [row] } = await pool.query<{ name: string; user_id: string | null }>(
      'SELECT name, user_id FROM partners WHERE id = $1::uuid',
      [id],
    ));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[reset-link] партнёр не прочитан:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 500 });
  }
  if (!row) return NextResponse.json({ success: false, error: 'Партнёр не найден' }, { status: 404 });
  if (!row.user_id) {
    return NextResponse.json(
      { success: false, error: 'У карточки нет аккаунта — сначала заведите его' },
      { status: 409 },
    );
  }

  let issued;
  try {
    issued = await issuePasswordResetToken({ userId: row.user_id, issuedBy: auth.userId, ttlMs: ADMIN_ISSUED_TTL_MS });
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[reset-link] ссылка не выдана:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      operator: row.name,
      link: issued.link,
      expires_at: issued.expiresAt.toISOString(),
      // Текст для пересылки — без ПД, только ссылка.
      message: [
        'Здравствуйте! Чтобы задать пароль для кабинета на Ведаре, откройте ссылку и введите новый пароль:',
        issued.link,
        'Ссылка действует сутки и годится один раз.',
      ].join('\n'),
    },
  });
}
