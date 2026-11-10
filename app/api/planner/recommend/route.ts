/**
 * POST /api/planner/recommend
 * AI-powered trip recommendation based on user profile, group, and interests.
 * Optionally loads saved preferences from AgentMemory for authenticated users.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { INTERESTS_MAX, describeRecommendError } from '@/lib/planner/recommend-errors';
import { recommendTrip } from '@/lib/planner/engine';
import { verifyAuth } from '@/lib/auth';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { MAX_REST_DAYS } from '@/lib/planner/travel-style';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

/** Потолок заметки о здоровье: коротко, «колено, астма», а не история болезни. */
const HEALTH_NOTES_MAX = 300;

/**
 * Предел частоты (#3199, (а)-1). Роут публичный, а сборка плана может звать
 * флагманскую модель — без предела любой цикл со стороны платил бы ею без
 * счёта. Общий лимит Edge есть только при Upstash, которого нет. Потолок
 * строже чата планера (20/мин): здесь каждый запрос — целый план; и с запасом
 * для людей за одним адресом. Ключ — доверенный адрес (x-real-ip первым):
 * подмена X-Forwarded-For лимит не обходит.
 */
export const RECOMMEND_LIMIT_PER_MIN = 10;
const recommendLimiter = createRateLimiter({ windowMs: 60_000, max: RECOMMEND_LIMIT_PER_MIN });


interface SavedPrefs {
  interests?: string[];
  fitnessLevel?: string;
  budgetTier?: string;
  adults?: number;
}

const RecommendSchema = z.object({
  // Потолок с запасом над числом чипов формы (14): прежние 12 отвергали
  // человека, отметившего почти всё (снимок владельца 26.09).
  interests: z.array(z.string().max(40)).min(1).max(INTERESTS_MAX),
  arrivalDate: z.string().date().optional(),
  departureDate: z.string().date().optional(),
  flightArrivalTime: z.string().max(5).optional(),
  flightDepartureTime: z.string().max(5).optional(),
  adults: z.number().int().min(1).max(20).default(2),
  children: z.array(z.number().int().min(0).max(17)).max(10).default([]),
  fitnessLevel: z.enum(['beginner', 'moderate', 'active']).default('moderate'),
  budgetTier: z.enum(['economy', 'comfort', 'premium']).default('comfort'),
  seasickness: z.boolean().default(false),
  // Здоровье — особая категория ПД. Приходит ТОЛЬКО сюда, в наш движок: в
  // модель (зарубежную, §8) не уходит, в память предпочтений не пишется, в
  // лог не попадает. Сторож: tests/unit/planner-health-stays-local.test.ts.
  healthNotes: z.string().trim().max(HEALTH_NOTES_MAX).optional(),
  mobilityLevel: z.enum(['full', 'limited', 'wheelchair']).optional(),
  // Стиль поездки и дни отдыха (владелец 26.09, lib/planner/travel-style).
  travelStyle: z.enum(['self', 'operator', 'mixed']).optional(),
  restDays: z.number().int().min(0).max(MAX_REST_DAYS).optional(),
  // Прилетает человек или живёт в крае (владелец 27.09,
  // lib/planner/trip-origin). Нет — прежнее поведение: считаем, что прилетает.
  tripOrigin: z.enum(['visitor', 'local']).optional(),
});

export async function POST(req: NextRequest) {
  if (!recommendLimiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429 },
    );
  }

  // Вход необязателен: план собирается и без него. Аноним verifyAuth не
  // бросает — бросок значит сбой проверки сессии, он называется в логе.
  let userId: string | null = null;
  try {
    const auth = await verifyAuth(req);
    userId = auth.userId ?? null;
  } catch (err) {
    logSwallowedFailure('planner-recommend', 'проверка входа', err);
  }

  try {
    const rawBody = await req.json() as unknown;

    // If authenticated, merge saved preferences (request body wins)
    let mergedBody: unknown = rawBody;
    if (userId) {
      try {
        const entry = await agentMemory.get('tourist-agency', 'user_preference', `user_${userId}_prefs`);
        if (entry) {
          const saved = entry.value as SavedPrefs;
          const bodyObj = rawBody as Record<string, unknown>;
          mergedBody = {
            interests:    bodyObj.interests    ?? saved.interests,
            fitnessLevel: bodyObj.fitnessLevel ?? saved.fitnessLevel,
            budgetTier:   bodyObj.budgetTier   ?? saved.budgetTier,
            adults:       bodyObj.adults       ?? saved.adults,
            ...bodyObj,
          };
        }
      } catch (err) {
        // Без сохранённых предпочтений план собирается по телу запроса.
        logSwallowedFailure('planner-recommend', 'чтение предпочтений', err);
      }
    }

    const parsed = RecommendSchema.parse(mergedBody);

    // Равные даты допустимы: это поездка на ОДИН день. Форма их и так
    // позволяет (`min={arrival}`), а сервер отвергал — и житель края,
    // собравший однодневный выход, получал отказ на том, что форма разрешила.
    if (parsed.arrivalDate && parsed.departureDate && parsed.departureDate < parsed.arrivalDate) {
      return NextResponse.json(
        // Нейтрально: у местного прилёта нет, а даты те же самые — первый и
        // последний день поездки (lib/planner/trip-origin).
        { success: false, error: 'Дата окончания должна быть позже даты начала' },
        { status: 400 },
      );
    }

    const recommendation = await recommendTrip(parsed);

    // Fire-and-forget: persist preferences for authenticated users
    if (userId) {
      agentMemory.remember({
        agent_id:    'tourist-agency',
        memory_type: 'user_preference',
        key:         `user_${userId}_prefs`,
        value: {
          interests:    parsed.interests,
          fitnessLevel: parsed.fitnessLevel,
          budgetTier:   parsed.budgetTier,
          adults:       parsed.adults,
          savedAt:      new Date().toISOString(),
        },
        confidence: 1.0,
        source:     'recommend_request',
      }).catch((err) => logSwallowedFailure('planner-recommend', 'запись предпочтений', err));
    }

    return NextResponse.json({ success: true, data: recommendation });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: describeRecommendError(err.issues), details: err.issues },
        { status: 400 },
      );
    }
    // Текст исключения наружу не уходит: у PostgreSQL и провайдеров модели он
    // называет таблицы, колонки и адреса. Планер показывает поле человеку.
    logSwallowedFailure('planner-recommend', 'сборка плана', err);
    return NextResponse.json(
      { success: false, error: 'План не собрался — попробуйте ещё раз через минуту' },
      { status: 500 },
    );
  }
}
