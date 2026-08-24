/**
 * POST /api/leads/[id]/proposal/send
 * Отправляет AI-предложение клиенту и обновляет статус лида на proposal_sent.
 *
 * Сама доставка — в lib/leads/proposal-delivery.ts: ту же функцию зовёт кнопка
 * «Отправить клиенту» в Telegram (#65). Здесь остаётся только авторизация,
 * разбор параметров и коды ответа.
 *
 * Body: { channel: 'telegram' | 'email' | 'both' }  (опционально, по умолчанию оба)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { sendProposalToClient } from '@/lib/leads/proposal-delivery';
import { canAccessLead } from '@/lib/leads/ownership';
import type { JWTPayload } from '@/lib/auth/jwt';
import { z } from 'zod';

const Schema = z.object({
  channel: z.enum(['telegram', 'email', 'both']).optional().default('both'),
});

const STATUS_BY_REASON = {
  not_found: 404,
  no_proposal: 409,
  already_sent: 409,
  proposal_missing: 404,
  // Каналы отказали, статус лида откачен — повтор осмысленен, значит 502,
  // а не 409: клиенту нечего показывать как «уже сделано».
  not_delivered: 502,
} as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOperator(req);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  const { id } = await params;

  // sendProposalToClient САМА не проверяет владение (её контракт это прямо
  // документирует) — вызывающий обязан проверить право до вызова. Раньше
  // это не делалось: оператор мог отправить чужому клиенту предложение по
  // чужому лиду, зная только UUID (аудит кабинета оператора).
  if (!(await canAccessLead(user, id))) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parse = Schema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: 'Неверные параметры' }, { status: 400 });
  }

  const outcome = await sendProposalToClient(id, parse.data.channel);

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.message }, { status: STATUS_BY_REASON[outcome.reason] });
  }

  return NextResponse.json({
    success: true,
    message: outcome.message,
    sent: outcome.sent,
    failed: outcome.failed,
    pdf_url: outcome.pdfUrl,
  });
}
