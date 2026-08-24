/**
 * GET /api/cron/kuzmich
 * Публикует AI-пост Кузьмича в Telegram-канал.
 *
 * Типы постов:
 *   route — маршрут дня (случайный, не повторяется 30 дней)
 *   tip   — практичный совет от Кузьмича
 *   sezon — сезонный пост про текущий месяц
 *   tour  — конкретный тур operator_tours (24.08: канал ни разу не постил
 *           реальные бронируемые туры — только бесплатные точки/маршруты)
 *
 * Если type не передан — выбирается по часу UTC (Камчатка UTC+12):
 *   09:00 KMT = 21:00 UTC → route
 *   14:00 KMT = 02:00 UTC → tip
 *   19:00 KMT = 07:00 UTC → sezon по нечётным дням месяца, tour по чётным
 *
 * Защита: ?secret=CRON_SECRET
 *
 * Настройка cron-job.org (3 задачи — четвёртой под tour НЕ заводим, он
 * приходит на слот sezon по чётным дням):
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=route   → 21:00 UTC ежедневно
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=tip     → 02:00 UTC ежедневно
 *   https://vedarai.ru/api/cron/kuzmich?secret=SECRET&type=sezon   → 07:00 UTC ежедневно
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  postKuzmichRoute,
  postKuzmichTip,
  postSezonToChannel,
  postFriendToChannel,
  postKuzmichTour,
} from '@/lib/notifications/telegram-channel';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

type PostType = 'route' | 'tip' | 'sezon' | 'friend' | 'tour';

/**
 * Слот 19:00 KMT чередует sezon/tour по чётности дня месяца — новой внешней
 * cron-задачи под туры не заводим (расписание держит cron-job.org СНАРУЖИ
 * репозитория). Владелец 24.08: «почему нет туров?» — канал ни разу не
 * упоминал operator_tours, весь трафик уходил на бесплатные точки/маршруты.
 */
function pickTypeByHour(): PostType {
  const now = new Date();
  const h = now.getUTCHours();
  if (h >= 20 && h <= 22) return 'route';  // 08–10 KMT
  if (h >= 1  && h <= 3)  return 'tip';    // 13–15 KMT
  if (h >= 6  && h <= 8)  return now.getUTCDate() % 2 === 0 ? 'tour' : 'sezon';  // 18–20 KMT
  return 'route';
}

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

  const typeParam = searchParams.get('type');
  const postType: PostType =
    typeParam === 'route' || typeParam === 'tip' || typeParam === 'sezon' || typeParam === 'friend' || typeParam === 'tour'
      ? typeParam
      : pickTypeByHour();

  let result: { ok: boolean; error?: string; routeId?: string; tourId?: number };

  if (postType === 'friend') {
    const slug = searchParams.get('slug') ?? '';
    if (!slug) return NextResponse.json({ success: false, error: 'slug обязателен для type=friend' }, { status: 400 });
    result = await postFriendToChannel(slug);
  } else if (postType === 'route') {
    result = await postKuzmichRoute();
  } else if (postType === 'tip') {
    result = await postKuzmichTip();
  } else if (postType === 'tour') {
    result = await postKuzmichTour();
  } else {
    result = await postSezonToChannel();
  }

  if (!result.ok) {
    return NextResponse.json(
      { success: false, type: postType, error: result.error },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    type: postType,
    routeId: result.routeId ?? null,
    tourId: result.tourId ?? null,
    timestamp: new Date().toISOString(),
  });
}
