/**
 * GET  /api/seat-requests/[id]/answer?k=<подпись> — что спрашивают (без ПД туриста).
 * POST /api/seat-requests/[id]/answer             — ответ оператора с сайта.
 *
 * AUTH: публичный; право отвечать — подпись над id запроса
 * (lib/seat-requests/core, operatorAnswerKey). Нужен там, где кнопки-действия
 * недоступны: заглушка в Telegram (без ПД — значит и без действий),
 * пересланная в WhatsApp ссылка, «Другая дата» с выбором по календарю.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { operatorReplyText, verifyOperatorAnswerKey } from '@/lib/seat-requests/core';
import { answerSeatRequest, readForOperator } from '@/lib/seat-requests/service';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });
const IdSchema = z.string().uuid();

const BodySchema = z.object({
  k: z.string().max(64),
  answer: z.enum(['yes', 'no', 'other_date']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД').optional(),
});

async function guard(req: NextRequest, rawId: string, key: string): Promise<{ id: string } | NextResponse> {
  if (!limiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }
  const id = IdSchema.safeParse(rawId);
  if (!id.success || !verifyOperatorAnswerKey(id.data, key)) {
    return NextResponse.json({ success: false, error: 'Ссылка недействительна' }, { status: 403 });
  }
  return { id: id.data };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, (await params).id, req.nextUrl.searchParams.get('k') ?? '');
  if (g instanceof NextResponse) return g;
  const view = await readForOperator(g.id);
  if (view === 'db_error') return NextResponse.json({ success: false, error: 'База не ответила, попробуйте через минуту' }, { status: 503 });
  if (view === null) return NextResponse.json({ success: false, error: 'Запрос не найден' }, { status: 404 });
  return NextResponse.json({ success: true, data: view });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const g = await guard(req, (await params).id, parsed.data.k);
  if (g instanceof NextResponse) return g;

  const { answer, date } = parsed.data;
  if (answer === 'other_date' && !date) {
    return NextResponse.json({ success: false, error: 'Укажите дату, которую предлагаете' }, { status: 400 });
  }
  const result = await answerSeatRequest(
    g.id,
    answer === 'other_date' ? { kind: 'other_date', date: date! } : { kind: answer },
    'web',
  );
  // Веб-страница выводит строку как текст, не HTML: экранировать нельзя.
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
