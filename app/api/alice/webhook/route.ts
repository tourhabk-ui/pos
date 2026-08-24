/**
 * POST /api/alice/webhook — вебхук навыка «Туры Камчатки» для Яндекс.Алисы.
 *
 * Читает только: список туров публичного каталога (operator_tours через
 * lib/search/tour-search.ts, тот же движок «Поиск», что у /catalog). Ничего
 * не пишет, ни с чьим аккаунтом не связывается — раскрывать в логах или
 * защищать особо нечего, это те же данные, что открыты на сайте.
 *
 * Навык — канал ОБНАРУЖЕНИЯ, не бронирования: за деталями и покупкой всегда
 * отправляет на сайт. Подробности решения — в шапке lib/alice/tours-skill.ts.
 *
 * Секрет в URL (?s=) — необязательная защита от случайного трафика, не от
 * подмены личности: lib/alice/webhook-url.ts. Регистрация навыка — вручную,
 * в консоли dialogs.yandex.ru, Webhook URL = aliceWebhookUrl().
 *
 * Отвечает 200 почти всегда: Алиса не умеет обрабатывать ошибки вебхука
 * иначе как тишиной пользователю, поэтому даже сбой оборачивается в честный
 * текст ответа, а не в 5xx.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { isVerifiedAliceWebhook } from '@/lib/alice/webhook-url';
import { handleAliceTours } from '@/lib/alice/tours-skill';
import type { AliceRequest, AliceResponse } from '@/lib/alice/types';
import { queryMarketplaceTours, MarketplaceToursQuerySchema } from '@/lib/search/tour-search';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

const AliceRequestSchema = z.object({
  meta: z.object({ locale: z.string(), timezone: z.string(), client_id: z.string() }).passthrough(),
  request: z.object({
    command: z.string(),
    original_utterance: z.string(),
    type: z.enum(['SimpleUtterance', 'ButtonPressed']),
    payload: z.unknown().optional(),
    nlu: z.object({
      tokens: z.array(z.string()),
      entities: z.array(z.unknown()).default([]),
      intents: z.record(z.string(), z.object({ slots: z.record(z.string(), z.unknown()) })).optional(),
    }).passthrough().optional(),
  }).passthrough(),
  session: z.object({
    message_id: z.number(),
    session_id: z.string(),
    skill_id: z.string(),
    user_id: z.string(),
    application: z.object({ application_id: z.string() }).passthrough(),
    new: z.boolean(),
  }).passthrough(),
  state: z.object({ session: z.unknown().optional() }).passthrough().optional(),
  version: z.literal('1.0'),
});

function fallback(text: string): NextResponse {
  const body: AliceResponse = { response: { text, end_session: false }, version: '1.0' };
  return NextResponse.json(body);
}

export async function POST(request: NextRequest) {
  if (!isVerifiedAliceWebhook(request.url)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = AliceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Не от Алисы вовсе (или протокол сменился) — 400, а не притворный ответ.
    return NextResponse.json({ error: 'Invalid request shape' }, { status: 400 });
  }
  const aliceReq = parsed.data as unknown as AliceRequest;

  try {
    const body = await handleAliceTours(aliceReq, (filters) => {
      const withDefaults = MarketplaceToursQuerySchema.parse({
        sort: 'recommended',
        limit: 5,
        offset: 0,
        ...filters,
      });
      return queryMarketplaceTours(withDefaults);
    });
    return NextResponse.json(body);
  } catch (err) {
    console.error('[alice] навык туров не ответил:', err instanceof Error ? err.message : err);
    return fallback('Что-то пошло не так, попробуйте ещё раз чуть позже.');
  }
}
