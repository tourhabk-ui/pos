/**
 * GET /api/bots/reposter/chats
 *
 * Возвращает список чатов/каналов, где MAX-бот (MAX_BOT_TOKEN) состоит.
 * Нужен, чтобы узнать chat_id MAX-каналов для REPOSTER_ROUTES и max_chat_id
 * (бэкфилл). Бот должен быть добавлен админом в нужные MAX-каналы.
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
