/**
 * API: один тикет поддержки.
 * GET /api/support/tickets/[id] — карточка (турист видит только свои)
 * PUT /api/support/tickets/[id] — статус / категория / Резидент (admin, agent)
 *
 * Единственный сервис — lib/support/ticket.service (см. ../route.ts, 04.09).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import {
  getTicketById, getTicketForUser, updateTicket, TICKET_CATEGORIES, TICKET_STATUSES,
} from '@/lib/support/ticket.service';

const UpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  assignedAgent: z.string().trim().min(1).max(30).optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), 'Укажите хотя бы одно поле');

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const isPrivileged = auth.role === 'admin' || auth.role === 'agent';
    const ticket = isPrivileged ? await getTicketById(id) : await getTicketForUser(id, auth.userId);
    if (!ticket) return NextResponse.json({ success: false, error: 'Заявка не найдена' }, { status: 404 });
    return NextResponse.json({ success: true, data: ticket });
  } catch (error) {
    console.error('[support/tickets/id] не прочитан:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось получить заявку' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const isPrivileged = auth.role === 'admin' || auth.role === 'agent';
  if (!isPrivileged) {
    // Турист меняет тикет только сообщением в переписке: статус ведёт агент.
    return NextResponse.json(
      { success: false, error: 'Статус заявки меняет служба поддержки — напишите сообщение в заявку' },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const parsed = UpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
        { status: 400 },
      );
    }
    const ticket = await updateTicket(id, parsed.data);
    if (!ticket) return NextResponse.json({ success: false, error: 'Заявка не найдена' }, { status: 404 });
    return NextResponse.json({ success: true, data: ticket });
  } catch (error) {
    console.error('[support/tickets/id] не обновлён:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, error: 'Не удалось обновить заявку' }, { status: 500 });
  }
}
