/**
 * POST /api/upload/tour-video/confirm — видео и обложка, записанные браузером
 * по подписанной ссылке, действительно в хранилище и того типа (05.11).
 * «Ссылку выдали» — не «загружено»: без этой проверки форма записала бы в тур
 * клип, которого нет, и карточка показала бы пустую рамку (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { headObjectInfo } from '@/lib/storage/s3';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  key: z.string().regex(/^videos\/tours\/[a-z0-9]{12}\.mp4$/),
  poster: z.string().regex(/^videos\/tours\/[a-z0-9]{12}\.jpg$/),
}).strict();

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide', 'operator', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Неверные ключи видео' }, { status: 400 });
  try {
    const [video, poster] = await Promise.all([headObjectInfo(body.data.key), headObjectInfo(body.data.poster)]);
    if (!video || video.size === 0) return NextResponse.json({ error: 'Видео в хранилище не дошло — загрузите ещё раз' }, { status: 409 });
    if (!poster || poster.size === 0) return NextResponse.json({ error: 'Обложка в хранилище не дошла — загрузите ещё раз' }, { status: 409 });
    if (video.contentType !== 'video/mp4' || poster.contentType !== 'image/jpeg') {
      return NextResponse.json({ error: 'В хранилище файл не того типа' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, sizeMb: Math.round(video.size / 1024 / 1024) });
  } catch (err) {
    console.error('[upload/tour-video/confirm] хранилище не ответило:', err instanceof Error ? err.message.slice(0, 160) : String(err));
    return NextResponse.json({ error: 'Не проверить, дошло ли видео, — хранилище не ответило' }, { status: 503 });
  }
}
