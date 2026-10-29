/**
 * GET /api/admin/leads/[id]/messages — переписка адресата заявки и клиента
 * по лиду (1350): кто писал, откуда (MAX или страница заявки), дошло ли и
 * почему нет.
 *
 * Повод — ревью 30.10: сообщение клиента, не дошедшее до адресата, уходит
 * оператору платформы, а заглушка в Telegram отсылает «текст — в админке, у
 * заявки». Без этого экрана текст лежал бы в базе, и обещание было бы
 * объявленным исходом без источника. Переписка заявок на жильё — в
 * /api/admin/stay-requests.
 *
 * Администратору текст положен: он передаёт сообщение, которое адресату не
 * дошло. Отказ базы — 503 с SQLSTATE в логе, а не пустая переписка (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid('Неверный номер заявки');

export interface AdminLeadMessage {
  author: 'owner' | 'guest';
  door: 'max' | 'page';
  body: string;
  delivery_channel: 'max' | 'no_address' | 'failed' | null;
  delivery_reason: string | null;
  created_at: string;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const parsed = IdSchema.safeParse((await params).id);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверный номер заявки' }, { status: 400 });
  }
  try {
    const { rows } = await pool.query<Omit<AdminLeadMessage, 'created_at'> & { created_at: Date }>(
      `SELECT author, door, body, delivery_channel, delivery_reason, created_at
         FROM request_messages
        WHERE lead_id = $1::uuid
        ORDER BY created_at, id
        LIMIT 500`,
      [parsed.data],
    );
    const data: AdminLeadMessage[] = rows.map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() }));
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[admin/leads/messages] переписка не прочитана:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Переписка не прочиталась — база не ответила.' }, { status: 503 });
  }
}
