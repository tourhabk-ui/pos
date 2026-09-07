/**
 * POST /api/tourist/feedback/agent — оценка ответа Кузьмича.
 *
 * Шапка называла адрес «публичным», и это было неверно: адреса нет в
 * PUBLIC_API_ROUTES, значит Edge требует сессию. Разбор периметра 07.09
 * нашёл здесь три вещи, и каждая своя.
 *
 * 1. СВОЙ СЧЁТЧИК ЧАСТОТЫ. В файле жила рукописная копия того, что уже есть
 *    в lib/rate-limit: своя Map, свой сброс окна. Две реализации одного
 *    расходятся молча — чинят одну, вторая остаётся. Теперь общая.
 *    Честно про её границы: счёт живёт в памяти процесса и рестарта не
 *    переживает. Для оценки ответа это принятая цена (запись дешёвая и не
 *    персональная), в отличие от приёма ПД в публичном MCP, где счёт ради
 *    этого переехал в базу.
 *
 * 2. ОТКАЗ ГЛУШИЛСЯ. Пустой `catch` превращал поломку записи в «ошибка
 *    записи» без единой строки в логе — §4.0 запрещает прямо: ловить можно,
 *    молчать нельзя.
 *
 * 3. ОЦЕНКА БЫЛА НИЧЬЯ. `chat_id` приходил от клиента и ни с кем не
 *    сверялся: вошедший мог оценивать чужие диалоги, а разобрать потом, кто
 *    что оценил, было нечем. Теперь рядом пишется автор из сессии.
 *
 * Пишет в ai_actions_log (action_type='agent_feedback').
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { getUserFromRequest } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  chat_id:  z.union([z.string(), z.number()]).transform(String),
  rating:   z.enum(['good', 'bad']),
  intent:   z.string().max(200).optional(),
  comment:  z.string().max(1000).optional(),
});

/** Десять оценок в минуту с адреса — та же цифра, что была у своей копии. */
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Невалидные данные' }, { status: 400 });
  }

  const { chat_id, rating, intent, comment } = parsed.data;

  // Автор оценки — из сессии, а не из тела запроса: иначе клиент называет
  // себя сам, и подпись под оценкой ничего не значит. Edge сессию уже
  // проверил; null здесь означает не «чужой», а «токен не разобрался», и
  // это записывается как есть — выдумывать автора нельзя.
  const user = await getUserFromRequest(req).catch(() => null);

  try {
    await pool.query(
      `INSERT INTO ai_actions_log (action_type, metadata, created_at)
       VALUES ('agent_feedback', $1, NOW())`,
      [JSON.stringify({
        chat_id,
        rating,
        intent: intent ?? null,
        comment: comment ?? null,
        agent_id: 'kuzmich',
        author_user_id: user?.userId ?? null,
      })],
    );
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    // Молчать нельзя (§4.0): без строки в логе «ошибка записи» неотличима
    // от «таблицы нет», «прав нет» и «поле не влезло».
    const code = (err as { code?: string })?.code ?? 'нет кода';
    console.error(`[agent-feedback] запись оценки не прошла, SQLSTATE ${code}:`, err);
    return NextResponse.json({ success: false, error: 'Ошибка записи' }, { status: 500 });
  }
}
