/**
 * POST /api/requests/pending/send { token, pd_consent: true } — человек
 * нажал «Отправить» на /confirm (#3399, п. 4; слово владельца 15.11 «Делай»).
 *
 * Только здесь заявка ИИ-агента записывается и уходит адресату. Согласие —
 * галочка человека на странице (источник request-page), а не флаг агента.
 * Второе нажатие ничего не отправит: заявка забирается один раз.
 *
 * AUTH: публичный (префикс /api/requests в реестре); доступ — по токену.
 * Третий исход (§4.0): база не ответила — 503 и «заявка ещё ждёт».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { sendPendingRequest, PENDING_GONE_TEXT, PENDING_PLAN_CHANGED_TEXT, PENDING_FAILED_TEXT } from '@/lib/mcp/pending-confirm';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const Schema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/),
  pd_consent: z.boolean(),
});

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные данные запроса' }, { status: 400 });
  }
  // Без галочки отправлять нечего: согласие даёт человек, а не помощник.
  if (parsed.data.pd_consent !== true) {
    return NextResponse.json({ success: false, error: 'Нужно согласие на обработку и передачу персональных данных' }, { status: 400 });
  }
  const out = await sendPendingRequest(parsed.data.token, { ip, userAgent: req.headers.get('user-agent') ?? '' });
  if (out.kind === 'failed') return NextResponse.json({ success: false, error: PENDING_FAILED_TEXT }, { status: 503 });
  if (out.kind === 'gone') return NextResponse.json({ success: false, error: PENDING_GONE_TEXT }, { status: 410 });
  if (out.kind === 'plan_changed') return NextResponse.json({ success: false, error: PENDING_PLAN_CHANGED_TEXT }, { status: 409 });
  if (out.kind === 'retry') return NextResponse.json({ success: false, error: out.text }, { status: 503 });
  return NextResponse.json({ success: true, data: { created: out.created, text: out.text } });
}
