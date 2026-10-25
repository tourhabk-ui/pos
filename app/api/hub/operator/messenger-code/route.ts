/**
 * POST /api/hub/operator/messenger-code — короткий код «/start ABC123».
 *
 * Код пишет чат в карточку партнёра из гарда, не в users.telegram_id.
 * Поэтому администратор в «Войти как» не получает командный центр.
 * Тело запроса не читается: партнёра из него взять нельзя.
 */

import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { requirePartnerOwner } from '@/lib/crm/partner-context';
import { issueBindCode } from '@/lib/partners/bind-code';
import { resolveTelegramBotUsername } from '@/lib/telegram/bot-username';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  const ctx = await requirePartnerOwner(req);
  if (ctx instanceof NextResponse) return ctx;
  await resolveTelegramBotUsername();
  const issued = await issueBindCode(ctx.partnerId);
  if (!issued) {
    return NextResponse.json(
      { success: false, error: 'Не удалось выдать код. Попробуйте ещё раз.' },
      { status: 503, headers: NO_STORE },
    );
  }
  let telegramQr: string | null = null;
  let maxQr: string | null = null;
  try {
    [telegramQr, maxQr] = await Promise.all([
      QRCode.toDataURL(issued.telegramUrl, { margin: 1, width: 280 }),
      QRCode.toDataURL(issued.maxUrl, { margin: 1, width: 280 }),
    ]);
  } catch (err) {
    console.error('[messenger-code] QR не собран', err instanceof Error ? err.message : err);
  }
  return NextResponse.json({
    success: true,
    code: issued.code,
    expiresAt: issued.expiresAt.toISOString(),
    telegramUrl: issued.telegramUrl,
    maxUrl: issued.maxUrl,
    telegramQr,
    maxQr,
  }, { headers: NO_STORE });
}
