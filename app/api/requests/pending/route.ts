/**
 * POST /api/requests/pending { token } — что человек увидит на /confirm
 * перед тем, как отправить заявку, которую подготовил ИИ-агент (#3399, п. 4).
 *
 * Токен — из ссылки, которую агент отдал человеку (во фрагменте адреса, в
 * логи не попадает); POST, а не GET, — чтобы токен не оказался в адресной
 * строке запроса и журналах прокси. В ответе: черновик (без ПД), имя и
 * телефон с замаскированными цифрами, чьи тексты согласия показать и срок ссылки.
 *
 * AUTH: публичный (префикс /api/requests в реестре); доступ — по токену и
 * с Origin сайта (fromVedarPage, ревью #3418) — барьер, не доказательство.
 * Третий исход (§4.0): база не ответила — 503, а не «ссылка недействительна».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readPendingRequest, maskedPhone, fromVedarPage } from '@/lib/mcp/pending-request';
import { consentPurposesForTool } from '@/lib/mcp/pending-confirm';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const Schema = z.object({ token: z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/) });

export async function POST(req: NextRequest) {
  if (!fromVedarPage(req.headers)) {
    return NextResponse.json({ success: false, error: 'Открыть и отправить заявку можно только на странице Ведара по ссылке из сообщения помощника.' }, { status: 403 });
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
  const read = await readPendingRequest(parsed.data.token);
  if (read.kind === 'failed') {
    return NextResponse.json({ success: false, error: 'Не удалось загрузить заявку, попробуйте через минуту' }, { status: 503 });
  }
  if (read.kind !== 'found') {
    return NextResponse.json({ success: true, data: { state: read.kind } });
  }
  return NextResponse.json({
    success: true,
    data: {
      state: 'pending',
      draft: read.draftText,
      name: read.name,
      phone: maskedPhone(read.phone),
      comment: read.comment,
      // Те же тексты, что запишет отправка (проход исполнителя в черновике);
      // догадка по аргументам — только у строки, где их не записали.
      consent_purposes: read.consentPurposes.length > 0 ? read.consentPurposes : consentPurposesForTool(read.tool, {
        tour: read.parts.tour, stay: read.parts.stay, transfer_destination: read.parts.transfer, carrier: read.parts.carrier,
      }),
      expires_at: read.expiresAt,
    },
  });
}
