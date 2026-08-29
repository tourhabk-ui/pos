/**
 * GET /api/cron/ai-channel-check — может ли бот публиковать в AI-канал.
 *
 * Отвечает на вопрос, который иначе выясняется неделей ожидания: канал
 * @ai_hub_money молчит потому, что дайджест не доходит до публикации, или
 * потому, что публиковать в него нельзя в принципе?
 *
 * ТОЛЬКО ЧТЕНИЕ. Пробного поста нет намеренно: в канале сорок тысяч
 * подписчиков, и «проверочное сообщение» увидят все сорок тысяч. Право
 * публиковать Telegram сообщает сам — getChat и getChatMember, без отправки.
 *
 * Три исхода, как и везде (§4.0): вправе публиковать · не вправе, вот
 * причина · не смог проверить. Последнее НЕ равно второму: недоступность
 * Telegram и запрет публикации лечатся в разных местах.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { readChannelAccess, describeAccess, type TgResponse } from '@/lib/agents/ai-channel-access';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_AI_CHANNEL_ID;

  // Отсутствие настройки — это ответ, а не сбой: он называет, чего не хватает.
  if (!token || !channelId) {
    const missing = [!token && 'TELEGRAM_BOT_TOKEN', !channelId && 'TELEGRAM_AI_CHANNEL_ID']
      .filter(Boolean).join(', ');
    return NextResponse.json({
      success: true,
      probe: 'ai_channel_check_v1',
      outcome: 'unknown',
      summary: `не смог проверить: не задано ${missing}`,
      channel_id_set: Boolean(channelId),
    });
  }

  const tg = async (method: string, params: Record<string, string>): Promise<TgResponse | null> => {
    try {
      const url = new URL(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/${method}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      // Telegram отвечает JSON и на ошибку (ok:false + description) — тело
      // нужно в обоих случаях, поэтому res.ok здесь не гейт.
      return (await res.json()) as TgResponse;
    } catch (err) {
      console.error(`[ai-channel-check] ${method} упал:`, err instanceof Error ? err.message : err);
      return null;
    }
  };

  // Кто мы: id бота нужен, чтобы спросить про ЕГО роль в канале.
  const me = await tg('getMe', {});
  const meResult = (typeof me?.result === 'object' && me?.result !== null ? me.result : {}) as {
    id?: unknown; username?: unknown;
  };
  const botId = typeof meResult.id === 'number' ? meResult.id : null;
  const botUsername = typeof meResult.username === 'string' ? meResult.username : null;

  if (!botId) {
    return NextResponse.json({
      success: true,
      probe: 'ai_channel_check_v1',
      outcome: 'unknown',
      summary: 'не смог проверить: Telegram не назвал бота (getMe не прошёл — токен или сеть)',
      channel_id_set: true,
    });
  }

  const chat = await tg('getChat', { chat_id: channelId });
  // getChatMember спрашиваем только если канал вообще виден: иначе ответ
  // будет о том же самом и лишь запутает отчёт.
  const member = chat?.ok === true
    ? await tg('getChatMember', { chat_id: channelId, user_id: String(botId) })
    : null;

  const access = readChannelAccess(chat, member);

  return NextResponse.json({
    success: true,
    probe: 'ai_channel_check_v1',
    outcome: access.kind,
    summary: describeAccess(access),
    bot: botUsername,
    channel_id_set: true,
    ...(access.kind !== 'unknown' && access.title ? { channel_title: access.title } : {}),
    ...(access.kind === 'cannot_post' ? { reason: access.reason } : {}),
    ...(access.kind === 'unknown' ? { reason: access.reason } : {}),
  });
}
