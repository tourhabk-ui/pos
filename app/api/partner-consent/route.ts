/**
 * POST /api/partner-consent — партнёр подписывает согласие на использование
 * материалов своего сайта на Ведаре (миграция 1321, решение владельца 23.10).
 *
 * AUTH: публичный (реестр: POST /api/partner-consent) — у партнёра нет
 * аккаунта, доказательство — ключ одноразовой ссылки от менеджера Ведара.
 * Без ключа писать некуда.
 *
 * Обязательны: текст, который показала страница (сервер собирает свой и
 * сверяет — разошлись, 409 и подписи нет), подтверждение полномочий и
 * согласие подписанта на обработку его имени и должности (purpose
 * 'partner-signer') — оно пишется той же вставкой, что и согласие партнёра.
 * Выбора объёма нет: он один и назван в тексте (ревью 23.10). Отказ базы —
 * 503 с SQLSTATE в логе, а не «записано».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { grantMaterialsConsent } from '@/lib/partners/material-consent';
import {
  CONSENT_TEXT_MAX, PARTNER_CONSENT_SOURCE, grantProblemText, isConsentKeyShape, normalizeSignerName,
  normalizeSignerRole,
} from '@/lib/partners/material-consent-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const Body = z.object({
  key: z.string().refine(isConsentKeyShape, 'Ссылка не распознана — откройте её из сообщения целиком'),
  signer_name: z.string().max(200),
  signer_role: z.string().max(200),
  text: z.string().max(CONSENT_TEXT_MAX),
  authority: z.boolean(),
  pd_consent: z.boolean(),
});

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) return fail(429, 'Слишком много запросов. Попробуйте через минуту.');

  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Неверные данные');
  const b = parsed.data;

  const signerName = normalizeSignerName(b.signer_name);
  if (!signerName) return fail(400, 'Укажите имя и фамилию буквами — от 2 до 120 знаков.');
  const signerRole = normalizeSignerRole(b.signer_role);
  if (!signerRole) return fail(400, 'Укажите должность или кем вы приходитесь партнёру — от 2 до 120 знаков.');
  if (b.authority !== true) return fail(400, 'Подтвердите, что вправе дать согласие от имени партнёра.');
  const pd = buildConsentRecord(b.pd_consent, ip, PARTNER_CONSENT_SOURCE, 'partner-signer');
  if (!pd) return fail(400, 'Нужно согласие на обработку имени и должности — без него согласие партнёра не записать.');

  try {
    const res = await grantMaterialsConsent({ key: b.key, signerName, signerRole, shownText: b.text, pd });
    if (!res.ok) {
      const status = res.reason === 'unknown' ? 404 : res.reason === 'text_changed' ? 409 : 410;
      return fail(status, grantProblemText(res.reason));
    }
    return NextResponse.json({ success: true, data: { granted_on: res.grantedOn, partner_name: res.partnerName } });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[partner-consent] согласие не записано: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return fail(503, 'Не смогли записать согласие — сбой на нашей стороне. Попробуйте позже.');
  }
}
