/**
 * POST /api/hub/crm/seat-requests/[id]/answer — ответ оператора на запрос мест
 * прямо из «Входящих» кабинета (CRM, хвосты фазы 1, #2325).
 *
 * До этого ответить можно было только кнопкой в MAX или по ссылке из
 * сообщения: во «Входящих» запрос был виден, а ответить там было нечем. Дверь
 * третья, функция та же — `answerSeatRequest` (lib/seat-requests/service):
 * атомарный захват, срок 2 часа, бронь при «есть места». Своего UPDATE здесь
 * нет.
 *
 * Право — вход в кабинет оператора (`requirePartner`, категория operator) и
 * запрос, адресованный ему (`requestBelongsToPartner`, operator_id в SQL).
 * Контактов туриста роут не читает и не отдаёт: они приходят оператору
 * уведомлением о брони только после «есть места» (решение 29.09).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { operatorReplyText } from '@/lib/seat-requests/core';
import { answerSeatRequest, requestBelongsToPartner } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Id = z.string().uuid();

export const SeatAnswerSchema = z.object({
  answer: z.enum(['yes', 'no', 'other_date']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД').optional(),
}).strict();

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.category !== 'operator') {
    return NextResponse.json({ success: false, error: 'Запросы мест получают операторы туров' }, { status: 403 });
  }

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ success: false, error: 'Запрос не найден' }, { status: 404 });

  const body: unknown = await req.json().catch(() => null);
  const parsed = SeatAnswerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const { answer, date } = parsed.data;
  if (answer === 'other_date' && !date) {
    return NextResponse.json({ success: false, error: 'Укажите дату, которую предлагаете' }, { status: 400 });
  }

  const own = await requestBelongsToPartner(id.data, ctx.partnerId);
  if (own === 'db_error') {
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте через минуту' }, { status: 503 });
  }
  // Чужой запрос — как несуществующий: id чужих запросов не подтверждаются.
  if (!own) return NextResponse.json({ success: false, error: 'Запрос не найден' }, { status: 404 });

  const result = await answerSeatRequest(
    id.data,
    answer === 'other_date' && date ? { kind: 'other_date', date } : { kind: answer === 'yes' ? 'yes' : 'no' },
    'web',
  );
  // Экран выводит строку как текст, не HTML: экранировать нельзя.
  const message = operatorReplyText(result, { html: false });
  if (!result.ok) {
    const status = result.reason === 'db_error' ? 503
      : result.reason === 'not_found' ? 404
      : result.reason === 'bad_date' ? 400
      : result.reason === 'accepted_unfinished' ? 202
      : 409;
    return NextResponse.json({ success: false, error: message, reason: result.reason }, { status });
  }
  return NextResponse.json({ success: true, data: { status: result.status, failed: result.status === 'failed', message } });
}
