/**
 * POST /api/partner-consent/invite — кто партнёр по ключу ссылки на согласие
 * и что он уже разрешил (миграция 1321, решение владельца 23.10). Страница
 * /partner-consent спрашивает это до формы: партнёр видит своё название и
 * сайты, а по устаревшей ссылке — словами, что делать.
 *
 * AUTH: публичный (реестр: POST по префиксу /api/partner-consent) —
 * доказательство здесь ключ. Ключ — в теле, не в адресе: адреса оседают в
 * логах. Имени прежнего подписанта в ответе нет: ссылку могли переслать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { checkConsentInvite } from '@/lib/partners/material-consent';
import { consentInviteProblemText, isConsentKeyShape } from '@/lib/partners/material-consent-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const Body = z.object({
  key: z.string().refine(isConsentKeyShape, 'Ссылка не распознана — откройте её из сообщения целиком'),
});

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: NextRequest) {
  if (!limiter.check(getTrustedClientIp(req.headers))) return fail(429, 'Слишком много запросов. Попробуйте через минуту.');

  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Неверные данные');

  try {
    const check = await checkConsentInvite(parsed.data.key);
    if (check.state !== 'ok') {
      return NextResponse.json({ success: true, data: { state: check.state, message: consentInviteProblemText(check.state) } });
    }
    return NextResponse.json({
      success: true,
      data: { state: 'ok', partner_name: check.partnerName, sites: check.sites, current: check.current },
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[partner-consent/invite] ссылка не проверена: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не смогли проверить ссылку — сбой на нашей стороне. Попробуйте позже.');
  }
}
