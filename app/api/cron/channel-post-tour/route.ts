/**
 * POST /api/cron/channel-post-tour — публикация тура оператора в канал.
 *
 * Приходит из .github/triggers/channel-post-tour.json через workflow
 * channel-post-tour.yml с Bearer CRON_SECRET (паттерн kml-inbox: токен бота
 * живёт только на проде, раннер его не видит).
 *
 * От ручного поста (/api/cron/channel-post) отличается тем, что текст и
 * фотографии НЕ приходят снаружи: и то и другое берётся из базы по id тура.
 * Так пост в канале не может разойтись с карточкой — а разошёлся бы он именно
 * в цене и в имени оператора, на чём мы уже обжигались.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { postTourToChannel } from '@/lib/notifications/tour-channel-post';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  tourId: z.string().min(1, 'tourId обязателен'),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  try {
    const outcome = await postTourToChannel(parsed.data.tourId);
    if (!outcome.ok) {
      return NextResponse.json({ success: false, error: outcome.error ?? 'Публикация не удалась' }, { status: 502 });
    }
    return NextResponse.json({
      success: true,
      duplicate: outcome.duplicate ?? false,
      photos: outcome.photos ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Ошибка публикации' },
      { status: 500 },
    );
  }
}
