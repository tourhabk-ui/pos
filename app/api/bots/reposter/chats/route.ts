/**
 * GET /api/bots/reposter/chats
 *
 * Чаты, которые бот запомнил из входящих событий, плюс id из базы
 * (партнёры) и из окружения (MAX_CHANNEL_ID, REPOSTER_ROUTES).
 * Готового списка у MAX больше нет. title и type бывают null: событие
 * их ещё не называло. Чужой чат, о котором не было события и которого
 * нет в этих источниках, здесь не появится.
 *
 * Требует роль admin. Env: MAX_BOT_TOKEN
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { maxListChats } from '@/lib/notifications/max-channel';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const result = await maxListChats();
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 });
  }

  // Отдаём только id/title/type — этого достаточно для маппинга каналов,
  // без лишних полей.
  const chats = Array.isArray(result.chats)
    ? result.chats.map((c) => {
        const chat = c as { chat_id?: number; title?: string; type?: string };
        return { chat_id: chat.chat_id, title: chat.title, type: chat.type };
      })
    : [];

  return NextResponse.json({ success: true, chats });
}
