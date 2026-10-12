/**
 * POST /api/requests/consent { key, pd_consent } — человек подтверждает
 * согласие на обработку ПД по заявке, которую за него отправил агент
 * (вторая половина ступени 1 контура, #2371).
 *
 * До этого в заявке стоит утверждение агента (`pd_consent_source = 'mcp'`,
 * долг в шапке lib/mcp/write-guard.ts); подтверждение человека пишется
 * поверх с источником `request-page` и текущей версией формулировки
 * (lib/legal/pd-consent) — та же галочка, что на формах сайта.
 *
 * AUTH: публичный (реестр lib/auth/public-api-routes); доступ — по ключу.
 * Частота — по IP. Третий исход (§4.0): база не ответила — 503, а не
 * «записано».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { confirmConsent, HUMAN_CONSENT_SOURCE } from '@/lib/mcp/request-status';
import { REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS } from '@/lib/mcp/request-status-schema';
import { McpUserError } from '@/lib/mcp/jsonrpc';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const Schema = z.object({
  key: z.string().trim().min(REQUEST_KEY_MIN_CHARS).max(REQUEST_KEY_MAX_CHARS),
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

  // null — галочки не было: это «не спрашивали», и записывать нечего.
  const consent = buildConsentRecord(parsed.data.pd_consent, ip, HUMAN_CONSENT_SOURCE);
  if (!consent) {
    return NextResponse.json({ success: false, error: 'Нужно согласие на обработку персональных данных' }, { status: 400 });
  }

  try {
    const outcome = await confirmConsent(parsed.data.key, consent);
    if (outcome === 'gone') {
      return NextResponse.json({ success: false, error: 'Заявка по этому ключу уже удалена' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: { consent: 'human', recorded: outcome === 'recorded' } });
  } catch (err) {
    if (err instanceof McpUserError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.code === 'key_not_found' ? 404 : 400 });
    }
    return NextResponse.json({ success: false, error: 'Не удалось записать согласие, попробуйте через минуту' }, { status: 503 });
  }
}
