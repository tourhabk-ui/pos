/**
 * POST /api/requests/pending/change { token } — человек нажал «Подтвердить» на
 * /confirm/change: отмена или перенос заявки, которые подготовил его ИИ-агент
 * (change_request; слово владельца 20.11 «1 для всех агентов», #3573).
 *
 * Черновик забирается один раз (claimPendingRequest, дверь 'change': черновик
 * заявки отсюда не забрать), изменение исполняет то же право ключа и то же
 * правило, что «Моя поездка» (applyPendingChange). Согласия на ПД здесь нет:
 * ничьи данные никуда не уходят — меняется своя заявка.
 *
 * AUTH: публичный (префикс /api/requests в реестре); доступ — по токену из
 * ссылки и с Origin сайта (fromVedarPage) — барьер, не доказательство.
 * Третий исход (§4.0): сбой до записи — 503, черновик снова ждёт; сбой после
 * — «не удалось подтвердить», а не «изменено» и не «не изменено».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { claimPendingRequest, releasePendingRequest, fromVedarPage } from '@/lib/mcp/pending-request';
import { applyPendingChange } from '@/lib/mcp/change-request';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const Schema = z.object({ token: z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/) });

const CHANGE_GONE_TEXT =
  'Это изменение уже подтверждено или ссылка истекла. Если заявку не меняли, попросите помощника подготовить ссылку заново.';
const CHANGE_RETRY_TEXT = 'Не удалось подтвердить: база Ведара не ответила. Нажмите «Подтвердить» через минуту — ссылка ещё действует.';
const CHANGE_UNKNOWN_TEXT =
  'Не удалось подтвердить, изменилась ли заявка: база Ведара ответила сбоем. Состояние заявки покажет ваш помощник (get_request_status) или страница заявки.';

export async function POST(req: NextRequest) {
  if (!fromVedarPage(req.headers)) {
    return NextResponse.json({ success: false, error: 'Подтвердить изменение можно только на странице Ведара по ссылке из сообщения помощника.' }, { status: 403 });
  }
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
    return NextResponse.json({ success: false, error: 'Ссылка неполная — откройте её целиком из сообщения помощника' }, { status: 400 });
  }
  const claim = await claimPendingRequest(parsed.data.token, 'change');
  if (claim.kind === 'failed') return NextResponse.json({ success: false, error: CHANGE_RETRY_TEXT }, { status: 503 });
  if (claim.kind === 'gone') return NextResponse.json({ success: false, error: CHANGE_GONE_TEXT }, { status: 410 });

  const out = await applyPendingChange(claim.args, claim.via);
  if (out.kind === 'failed') {
    // До записи — черновик снова ждёт, повтор безопасен. После — дошла ли
    // запись, неизвестно: в ожидание не возвращаем, говорим «не могу подтвердить».
    if (out.beforeWrite && await releasePendingRequest(parsed.data.token, claim.args)) {
      return NextResponse.json({ success: false, error: CHANGE_RETRY_TEXT }, { status: 503 });
    }
    return NextResponse.json({ success: true, data: { changed: false, text: CHANGE_UNKNOWN_TEXT } });
  }
  if (out.kind === 'refused') return NextResponse.json({ success: true, data: { changed: false, text: out.text } });
  return NextResponse.json({ success: true, data: { changed: out.result.changed, outcome: out.result.outcome, text: out.result.human } });
}
