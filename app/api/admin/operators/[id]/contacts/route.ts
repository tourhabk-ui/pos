/**
 * PATCH /api/admin/operators/[id]/contacts
 * Обновляет поля в contacts JSONB оператора (telegram_chat_id и др.)
 *
 * telegram_chat_id пишется ДВАЖДЫ — в колонку partners.telegram_chat_id и в
 * contacts JSONB (29.09). До этого — только в JSONB, а уведомление о брони и
 * перепись operator-reach читают колонку: чат, вписанный администратором
 * руками, получал лиды и не получал ни одной брони. Основной путь теперь —
 * ссылка привязки (POST .../channel-link), ручной ввод оставлен для
 * исключений.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  // Число чата Telegram: у лички положительное, у группы — отрицательное.
  // До 18 цифр: 19-значное число может не поместиться в bigint (23... 22003).
  telegram_chat_id: z.string().regex(/^-?\d{1,18}$/, 'chat_id Telegram — целое число до 18 цифр').nullable().optional(),
  phone:            z.string().max(30).optional(),
  email:            z.string().email().optional().nullable(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const idParsed = z.string().uuid().safeParse((await params).id);
  if (!idParsed.success) return NextResponse.json({ error: 'Неверный идентификатор оператора' }, { status: 400 });
  const id = idParsed.data;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  // Собираем только переданные поля
  const updates: Record<string, string | null> = {};
  if (parsed.data.telegram_chat_id !== undefined) updates.telegram_chat_id = parsed.data.telegram_chat_id;
  if (parsed.data.phone            !== undefined) updates.phone            = parsed.data.phone;
  if (parsed.data.email            !== undefined) updates.email            = parsed.data.email;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Нет данных для обновления' }, { status: 400 });
  }

  const touchesTelegram = parsed.data.telegram_chat_id !== undefined;
  let rows: Array<{ id: string; telegram_chat_id: string | null }>;
  try {
    ({ rows } = await pool.query<{ id: string; telegram_chat_id: string | null }>(
      `UPDATE partners
       SET contacts   = (CASE WHEN jsonb_typeof(contacts) = 'object' THEN contacts
                                WHEN contacts IS NULL OR contacts IN ('[]'::jsonb, 'null'::jsonb) THEN '{}'::jsonb
                                ELSE contacts END) || $1::jsonb,
           telegram_chat_id = CASE WHEN $3::boolean THEN $4::bigint ELSE telegram_chat_id END,
           updated_at = NOW()
       WHERE id = $2::uuid
       RETURNING id, contacts->>'telegram_chat_id' AS telegram_chat_id`,
      [JSON.stringify(updates), id, touchesTelegram, parsed.data.telegram_chat_id ?? null],
    ));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[admin/operators/contacts] не записано:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ error: 'Не удалось сохранить контакты, база не ответила' }, { status: 500 });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Оператор не найден' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    telegram_chat_id: rows[0]!.telegram_chat_id,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const { rows } = await pool.query(
    `SELECT contacts, contacts->>'telegram_chat_id' AS telegram_chat_id
     FROM partners WHERE id = $1`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Оператор не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, ...(rows[0] as Record<string, unknown>) });
}
