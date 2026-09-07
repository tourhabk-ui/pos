/**
 * API: переписка по тикету.
 * GET  /api/support/tickets/[id]/messages — сообщения тикета
 * POST /api/support/tickets/[id]/messages — добавить сообщение
 *
 * Переписка живёт в support_tickets.messages (JSONB [{role, text, ts}],
 * миграция 078) — там же, куда пишут админка и Telegram-бот. До 04.09 этот
 * роут писал в отдельную таблицу ticket_messages, которую никто не читал:
 * ответ агента из админки турист не видел, а его сообщение не видел агент.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { addTicketMessage, getTicketById, getTicketForUser } from '@/lib/support/ticket.service';

const MessageSchema = z.object({
  content: z.string().trim().min(1, 'Текст сообщения обязателен').max(5000, 'Сообщение не длиннее 5000 символов'),
});

type Ctx = { params: Promise<{ id: string }> };

async function loadFor(auth: { userId: string; role?: string }, id: string) {
  const isPrivileged = auth.role === 'admin' || auth.role === 'agent';
  return { isPrivileged, ticket: isPrivileged ? await getTicketById(id) : await getTicketForUser(id, auth.userId) };
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const { ticket } = await loadFor(auth, id);
    if (!ticket) return NextResponse.json({ success: false, error: 'Заявка не найдена' }, { status: 404 });
    return NextResponse.json({ success: true, data: ticket.messages });
  } catch (error) {
    console.error('[support/messages] не прочитаны:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось получить переписку' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const { isPrivileged, ticket } = await loadFor(auth, id);
    if (!ticket) return NextResponse.json({ success: false, error: 'Заявка не найдена' }, { status: 404 });

    const parsed = MessageSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
        { status: 400 },
      );
    }
    const message = { role: isPrivileged ? ('agent' as const) : ('user' as const), text: parsed.data.content };
    await addTicketMessage(id, message);
    return NextResponse.json({ success: true, data: { ...message, ts: new Date().toISOString() } });
  } catch (error) {
    console.error('[support/messages] не добавлено:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось отправить сообщение' }, { status: 500 });
  }
}
