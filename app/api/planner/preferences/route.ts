/**
 * GET/POST /api/planner/preferences
 * Save and retrieve user trip preferences via AgentMemory.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { MAX_ADULTS } from '@/lib/planner/party-limits';

const PreferencesSchema = z.object({
  interests:    z.array(z.string()).min(1).max(20),
  fitnessLevel: z.string().min(1).max(50),
  budgetTier:   z.string().min(1).max(50),
  adults:       z.number().int().min(1).max(MAX_ADULTS),
});

export async function POST(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;

  const userId = authResult.userId;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  try {
    const parsed = PreferencesSchema.parse(body);

    const value = {
      interests:    parsed.interests,
      fitnessLevel: parsed.fitnessLevel,
      budgetTier:   parsed.budgetTier,
      adults:       parsed.adults,
      savedAt:      new Date().toISOString(),
    };

    await agentMemory.remember({
      agent_id:    'tourist-agency',
      memory_type: 'user_preference',
      key:         `user_${userId}_prefs`,
      value,
      confidence:  1.0,
      source:      'user_input',
    });

    return NextResponse.json({ success: true, data: value });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Некорректные параметры', details: err.issues },
        { status: 400 },
      );
    }
    // Текст исключения наружу не уходит (разбор 14.11, экран-17): у базы он
    // называет таблицы и колонки. Причина — в лог.
    logSwallowedFailure('planner-preferences', 'сохранение предпочтений', err);
    return NextResponse.json({ success: false, error: 'Предпочтения не сохранились — попробуйте позже' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;

  const userId = authResult.userId;

  try {
    const entry = await agentMemory.get('tourist-agency', 'user_preference', `user_${userId}_prefs`);

    if (!entry) {
      return NextResponse.json({ success: true, data: null });
    }

    return NextResponse.json({ success: true, data: entry.value });
  } catch (err) {
    logSwallowedFailure('planner-preferences', 'чтение предпочтений', err);
    return NextResponse.json({ success: false, error: 'Предпочтения не прочитались — попробуйте позже' }, { status: 500 });
  }
}
