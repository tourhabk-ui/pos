/**
 * GET /api/alice/setup — только для владельца: URL, который нужно вставить
 * в поле «Webhook URL» при создании навыка в консоли dialogs.yandex.ru.
 *
 * У Яндекс.Диалогов нет публичного API регистрации навыка (в отличие от
 * Telegram/MAX, где вебхук ставится вызовом): привязка URL к скиллу — это
 * шаг в веб-консоли, руками. Поэтому здесь только READ — показать текущий
 * URL и признаки готовности, не более.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { aliceWebhookUrl, redactAliceWebhookUrl } from '@/lib/alice/webhook-url';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  return NextResponse.json({
    webhook_url: redactAliceWebhookUrl(aliceWebhookUrl()),
    secret_configured: Boolean(process.env.ALICE_WEBHOOK_SECRET),
    instructions:
      'Вставьте webhook_url в поле Webhook URL при создании навыка на dialogs.yandex.ru. ' +
      'Тип навыка — с сохранением состояния (State: Server storage не требуется, используется session_state).',
  });
}
