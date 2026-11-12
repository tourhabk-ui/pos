/**
 * POST /api/planner/companion
 *
 * AI-powered trip companion chat. Receives the user's question along with
 * the current trip context (days, zones, activities) and returns a
 * conversational reply in Russian.
 *
 * Правка #3199, (в)-3 (вариант Б, 10.11):
 *  - текст человека и контекст плана уходят в зарубежную модель только
 *    через redactPII — тот же рубеж, что у /api/planner/chat (Б29);
 *  - из подсказки сняты зашитые числа (градусы, часы переезда) и «назови
 *    диапазон цен»: у помощника нет инструментов, и цены, погода, наличие
 *    мест и безопасность здесь не называются — он отсылает к строкам плана
 *    и к Кузьмичу (CLAUDE.md §8: критичные факты — только из данных);
 *  - ключ лимита — доверенный адрес (x-real-ip), отказ модели — в логе.
 * Снять помощника целиком (вариант А) — решение владельца.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { callAIWithModelDirect } from '@/lib/ai/providers';
import { getModelForAgent } from '@/lib/ai/agent-models';
import type { ChatMessage } from '@/lib/ai/prompts';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { redactPII } from '@/lib/security/pii-redact';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { withSosBlock, buildSosBlock, detectEmergency } from '@/lib/safety/sos-detector';

export const dynamic = 'force-dynamic';

const companionLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const BodySchema = z.object({
  message: z.string().min(1).max(500),
  context: z.string().max(2000).default(''),
});

const COMPANION_SYSTEM = `Ты -- персональный помощник путешественника на платформе TourHab (Камчатка).
У тебя есть контекст текущего маршрута пользователя (ниже).

Правила:
- Отвечай кратко (2-4 предложения), по делу, на русском
- Без эмодзи, без markdown-ссылок
- Цены, погоду, прогноз, свободные места, время переездов и безопасность мест НЕ называй: данных о них у тебя нет. Цены и предупреждения есть в строках плана выше — сошлись на них; погоду, места и безопасность подскажет Кузьмич (чат на сайте), точные цены — оператор
- Числа называй только те, что есть в контексте плана; своих не придумывай
- Если вопрос о снаряжении -- дай общий список для активности и скажи, что точный список даёт оператор тура
- Если вопрос не связан с путешествием -- вежливо верни к теме планирования
- Если в контексте плана есть предупреждения -- повтори их своими словами, не смягчая`;

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers);
  if (!companionLimiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Сообщение обязательно' }, { status: 400 });
  }

  const { message, context } = parsed.data;

  // В модель — только очищенный текст: телефон или почта, вписанные в
  // вопрос или пришедшие в контексте, за рубеж не уходят.
  const userContent = context
    ? `Контекст маршрута:\n${redactPII(context)}\n\nВопрос: ${redactPII(message)}`
    : redactPII(message);

  const messages: ChatMessage[] = [
    { role: 'system', content: COMPANION_SYSTEM },
    { role: 'user', content: userContent },
  ];

  try {
    const reply = await callAIWithModelDirect(messages, getModelForAgent('planner'));
    // Серверная SOS-страховка (общая с чатом Кузьмича): признаки ЧП в вопросе
    // — телефоны 112/МЧС добавляются к ответу независимо от модели
    const sos = withSosBlock(reply, message);
    return NextResponse.json({ success: true, reply: sos.text, ...(sos.emergency ? { emergency: true } : {}) });
  } catch (err) {
    logSwallowedFailure('planner-companion', 'ответ модели', err);
    // Даже при мёртвом конвейере человек в ЧП получает телефоны
    const detection = detectEmergency(message);
    if (detection.detected) {
      return NextResponse.json({ success: true, reply: buildSosBlock(detection.categories), emergency: true });
    }
    return NextResponse.json(
      { success: false, error: 'Сервис временно недоступен' },
      { status: 503 },
    );
  }
}
