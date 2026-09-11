/**
 * POST /api/agents/operator
 *
 * AI Agent endpoint for operators.
 * Allows only op_* intents.
 * Requires operator role (JWT auth_token cookie).
 *
 * Body: { message: string, tourId?: number }
 * Response: { success, intent, response, data }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { PlatformAgent } from '@/lib/agents/platform-agent';
import { canDispatchIntent, allowedIntentsForRole } from '@/lib/agents/permissions';
import { OPERATOR_COMMAND_EXAMPLES } from '@/lib/agents/operator-commands';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  message: z.string().min(1).max(2000),
  tourId: z.number().int().positive().optional(),
  sessionId: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  const authResult = await requireRole(req, ['operator']);
  if (authResult instanceof NextResponse) return authResult;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные данные', details: parsed.error.issues },
      { status: 400 }
    );
  }

  // Build message: if tourId passed, prepend it
  let message = parsed.data.message;
  if (parsed.data.tourId) {
    message = `${message} тур ${parsed.data.tourId}`;
  }

  // Dispatch via PlatformAgent
  const result = await PlatformAgent.dispatch({
    message,
    userId: parseInt(authResult.userId, 10),
    role: 'operator',
    sessionId: parsed.data.sessionId,
  });

  // Нераспознанная команда — не отказ прав. До 11.09 «unknown» уходил в тот
  // же 403 «недоступно роли», и человек читал запрет там, где его просто не
  // поняли (#1800). Разные исходы — разные ответы (§4.0).
  if (result.intent === 'unknown') {
    return NextResponse.json(
      {
        success: false,
        error: 'Не понял команду. Вот что я умею: ' + OPERATOR_COMMAND_EXAMPLES.map((e) => e.message).join('; '),
        examples: OPERATOR_COMMAND_EXAMPLES.map((e) => ({ label: e.label, message: e.message })),
      },
      { status: 422 }
    );
  }

  // Permission gate: only op_* allowed
  if (!canDispatchIntent('operator', result.intent)) {
    // Отказ называет и намерение, и то, что роли доступно. «Недостаточно прав»
    // без этого не отличимо от поломки: оператор не знает, ошибся ли он
    // формулировкой или упёрся в границу роли.
    return NextResponse.json(
      {
        success: false,
        error: `Намерение «${result.intent}» недоступно роли «оператор»`,
        allowed_intents: allowedIntentsForRole('operator'),
      },
      { status: 403 }
    );
  }

  return NextResponse.json({ success: true, ...result });
}
