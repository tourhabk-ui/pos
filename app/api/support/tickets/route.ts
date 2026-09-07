/**
 * API: тикеты поддержки — список и создание.
 * GET  /api/support/tickets — свои тикеты (турист) или все (admin/agent)
 * POST /api/support/tickets — создать тикет из веб-формы
 *
 * До 04.09 роут ходил через «столповый» сервис, который INSERT-ил колонки
 * description / priority / customer_id / customer_name — их в support_tickets
 * нет (миграция 078 + 698). Создание тикета с экрана туриста падало по
 * построению, а сторожа схемы этого не видели, потому что pillars/ не
 * сканировался. Теперь — единственный сервис lib/support/ticket.service,
 * тот же, что у админки и Telegram-бота.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import {
  createTicket, listTickets, listUserTickets, TICKET_CATEGORIES, TICKET_STATUSES,
} from '@/lib/support/ticket.service';

const CreateSchema = z.object({
  subject: z.string().trim().min(1, 'Укажите тему').max(255, 'Тема не длиннее 255 символов'),
  description: z.string().trim().min(10, 'Опишите ситуацию хотя бы в 10 символах').max(5000, 'Описание не длиннее 5000 символов'),
  category: z.enum(TICKET_CATEGORIES).optional(),
  customerName: z.string().trim().max(255).optional(),
  customerEmail: z.string().trim().email('Некорректный email').max(255).optional().or(z.literal('')),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const sp = request.nextUrl.searchParams;
    const status = sp.get('status') ?? undefined;
    if (status && !(TICKET_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ success: false, error: 'Неизвестный статус' }, { status: 400 });
    }
    const isPrivileged = auth.role === 'admin' || auth.role === 'agent';
    const tickets = isPrivileged
      ? await listTickets({ status, category: sp.get('category') ?? undefined })
      : await listUserTickets(auth.userId, { status, limit: parseInt(sp.get('limit') || '50', 10) });
    return NextResponse.json({ success: true, data: tickets });
  } catch (error) {
    console.error('[support/tickets] список не прочитан:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось получить заявки' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const parsed = CreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
        { status: 400 },
      );
    }
    const d = parsed.data;
    const ticket = await createTicket({
      userId: auth.userId,
      channel: 'web',
      subject: d.subject,
      firstMessage: d.description,
      category: d.category,
      userName: d.customerName || null,
      userEmail: d.customerEmail || null,
    });
    return NextResponse.json({ success: true, data: ticket });
  } catch (error) {
    console.error('[support/tickets] тикет не создан:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось создать заявку' }, { status: 500 });
  }
}
