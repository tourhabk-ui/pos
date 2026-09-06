/**
 * GET /api/cron/kuzmich
 * Публикует AI-пост Кузьмича в Telegram-канал.
 *
 * Типы постов:
 *   route — место дня (со своим фото, текст из записи, не повторяется 30 дней)
 *   tip   — практичный совет от Кузьмича
 *   tour  — живой тур operator_tours с фотографиями оператора, текст из
 *           карточки; ротация по давности публикации
 *   sezon — АЛИАС tour (решение владельца 05.09: «вместо сезонов публиковать
 *           туры»). Сезонный пост остался ручной командой /sezon в боте.
 *
 * Если type не передан — выбирается по часу UTC (Камчатка UTC+12):
 *   09:00 KMT = 21:00 UTC → route
 *   14:00 KMT = 02:00 UTC → tip
 *   19:00 KMT = 07:00 UTC → tour
 *
 * Защита: ?secret=CRON_SECRET
 *
 * Настройка cron-job.org (3 задачи, менять НЕ нужно: третья с type=sezon
 * теперь публикует тур):
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=route   → 21:00 UTC ежедневно
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=tip     → 02:00 UTC ежедневно
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=sezon   → 07:00 UTC ежедневно (= tour)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  postKuzmichRoute,
  postKuzmichTip,
  postFriendToChannel,
  postKuzmichTour,
} from '@/lib/notifications/telegram-channel';
import { resolvePostType } from '@/lib/notifications/kuzmich-post-slot';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

// Слот и алиасы — lib/notifications/kuzmich-post-slot.ts (решение владельца
// 05.09: вечерний слот — туры; `type=sezon` означает тур, чтобы не зависеть
// от того, что именно передаёт cron-job.org).

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured on server' },
      { status: 500 }
    );
  }

  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const resolved = resolvePostType(searchParams.get('type'));
  const postType = resolved.type;

  let result: { ok: boolean; error?: string; routeId?: string; tourId?: number };

  if (postType === 'friend') {
    const slug = searchParams.get('slug') ?? '';
    if (!slug) return NextResponse.json({ success: false, error: 'slug обязателен для type=friend' }, { status: 400 });
    result = await postFriendToChannel(slug);
  } else if (postType === 'route') {
    result = await postKuzmichRoute();
  } else if (postType === 'tip') {
    result = await postKuzmichTip();
  } else {
    result = await postKuzmichTour();
  }

  if (!result.ok) {
    return NextResponse.json(
      { success: false, type: postType, requested: resolved.requested ?? null, error: result.error },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    type: postType,
    requested: resolved.requested ?? null,
    routeId: result.routeId ?? null,
    tourId: result.tourId ?? null,
    timestamp: new Date().toISOString(),
  });
}
