/**
 * POST /api/cron/channel-post — ручной пост в публичный канал через бота.
 *
 * Содержимое приходит из .github/triggers/channel-post.json через workflow
 * channel-post.yml с Bearer CRON_SECRET (паттерн kml-inbox: токен бота есть
 * только на проде, раннер его не видит). Публикация идемпотентна по тексту.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { ManualChannelPostSchema, publishManualChannelPost } from '@/lib/notifications/manual-channel-post';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = ManualChannelPostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  try {
    const outcome = await publishManualChannelPost(parsed.data);
    if (!outcome.ok) {
      return NextResponse.json({ success: false, error: outcome.error ?? 'Публикация не удалась' }, { status: 502 });
    }
    return NextResponse.json({ success: true, duplicate: outcome.duplicate ?? false });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Ошибка публикации поста' },
      { status: 500 },
    );
  }
}
