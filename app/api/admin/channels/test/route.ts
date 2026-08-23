/**
 * POST /api/admin/channels/test
 * Тест-публикация в каналы (Telegram + MAX) без cron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import {
  postKuzmichRoute,
  postKuzmichTip,
  postSezonToChannel,
  postSafetyToChannel,
  postAINewsToChannel,
  maxChannelPost,
} from '@/lib/notifications/telegram-channel';
import type { IntelligenceFinding } from '@/lib/services/intelligence-monitor.service';
import { query } from '@/lib/database';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  type: z.enum(['kuzmich_route', 'tip', 'sezon', 'safety', 'ai_news', 'max']),
  topic: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { type, topic } = parsed.data;

  try {
    let result: { ok: boolean; error?: string; routeId?: string };

    if (type === 'ai_news') {
      // Тестовый AI-finding для проверки канала
      const testFinding: IntelligenceFinding = {
        domain: 'ai_tech',
        summary: topic || 'Тест публикации AI-новостей: проверка работы канала и форматирования постов.',
        signals: [{
          title: 'Тестовый сигнал',
          source: 'vedarai.ru',
          url: 'https://vedarai.ru',
          snippet: 'Это тестовая публикация для проверки канала AI-новостей.',
        }],
        urgency: 'notable',
        action_items: ['Проверить оформление поста', 'Убедиться что фото загружается'],
      };
      // skipLLM: тест проверяет канал (пост+фото), а не генерацию текста —
      // без ожидания LLM цепочка укладывается в таймаут (иначе «Failed to fetch»).
      result = await postAINewsToChannel(testFinding, { skipLLM: true });
    } else if (type === 'max') {
      // Прямой тест ТОЛЬКО MAX-канала с сырой причиной отказа. Владелец 06.08:
      // «MAX канал не публикует новости» — а отказы были fire-and-forget, и
      // причину не видел никто. Этот тип возвращает её словами.
      result = await maxChannelPost(
        topic || '<b>Тест MAX-канала</b>\n\nПроверка публикации: если это сообщение видно в канале — доставка работает.',
      );
    } else {
      switch (type) {
        case 'kuzmich_route': result = await postKuzmichRoute(); break;
        case 'tip':           result = await postKuzmichTip();   break;
        case 'sezon':         result = await postSezonToChannel(); break;
        case 'safety':        result = await postSafetyToChannel(topic); break;
        default:              result = { ok: false, error: 'Unknown type' };
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  // Последние отказы MAX — причина словами, открывается браузером с телефона.
  // Владелец 06.08 дважды сообщил «в MAX поста нет»; записи ведёт
  // recordMaxFailure (telegram-channel.ts), здесь — чтение в один клик.
  let maxFailures: unknown = 'журнал недоступен';
  try {
    const { rows } = await query(
      `SELECT metadata->>'error' AS error,
              metadata->>'text_preview' AS text_preview,
              created_at
         FROM ai_actions_log
        WHERE action_type = 'max_post_failed'
        ORDER BY created_at DESC
        LIMIT 10`,
    );
    maxFailures = rows;
  } catch { /* таблица недоступна — оставляем пометку */ }

  return NextResponse.json({
    tourhab_channel: {
      configured: !!process.env.TELEGRAM_CHANNEL_ID,
      link: process.env.TELEGRAM_CHANNEL_LINK ?? null,
    },
    ai_news_channel: {
      configured: !!process.env.TELEGRAM_AI_CHANNEL_ID,
      link: process.env.TELEGRAM_AI_CHANNEL_LINK ?? null,
    },
    max_channel: {
      configured: !!(process.env.MAX_BOT_TOKEN && process.env.MAX_CHANNEL_ID),
      token_set: !!process.env.MAX_BOT_TOKEN,
      channel_id_set: !!process.env.MAX_CHANNEL_ID,
      link: process.env.MAX_CHANNEL_LINK ?? null,
      recent_failures: maxFailures,
    },
    // Рабочий чат в MAX — единственный адрес, куда уходят имя и телефон
    // туриста. Не задан — ПД не уходят никому, оператор видит только заглушку.
    max_operator_chat: {
      configured: !!(process.env.MAX_BOT_TOKEN && process.env.MAX_OPERATOR_CHAT_ID),
      chat_id_set: !!process.env.MAX_OPERATOR_CHAT_ID,
      collides_with_public_channel:
        !!process.env.MAX_OPERATOR_CHAT_ID &&
        process.env.MAX_OPERATOR_CHAT_ID.trim() === (process.env.MAX_CHANNEL_ID ?? '').trim(),
      note: process.env.MAX_OPERATOR_CHAT_ID
        ? null
        : 'MAX_OPERATOR_CHAT_ID не задан: ПД лидов не доставляются, в Telegram уходит заглушка без имени и телефона.',
    },
  });
}
