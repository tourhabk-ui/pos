/**
 * POST /api/upload/tour-video — ссылки на прямую запись видео тура и его
 * обложки в хранилище (05.11, слово владельца «да делай» на видео к туру;
 * «фото и видео в s3 — у нас есть инфраструктура»).
 *
 * До этого дня клип тура (миграция 1194) появлялся только миграцией. Байты
 * ролика через приложение не идут: браузер гида пишет их сам по подписанной
 * ссылке (`presignPutUrl`), контейнеру с 4 ГБ на всё и прокси перед ним они
 * не грозят. Подписаны тип и размер: больше заявленного хранилище не примет.
 *
 * Тело: `{ videoSize, posterSize }` в байтах. Ответ: ключи
 * `videos/tours/<случайные-12>.mp4|.jpg` (их принимает правка тура,
 * `OWN_CLIP_KEY`), ссылки на запись (15 минут) и публичные адреса. После
 * записи клиент зовёт `POST /api/upload/tour-video/confirm` — объект на месте
 * и того типа, а не «ссылку выдали — значит загружено» (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { isS3Configured, presignPutUrl, s3PublicUrl } from '@/lib/storage/s3';

export const dynamic = 'force-dynamic';

const MB = 1024 * 1024;

const BodySchema = z.object({
  videoSize: z.number().int().min(1).max(500 * MB, 'Видео больше 500 МБ — укоротите ролик'),
  posterSize: z.number().int().min(1).max(2 * MB, 'Обложка больше 2 МБ'),
}).strict();

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide', 'operator', 'admin']);
  if (auth instanceof NextResponse) return auth;
  if (!isS3Configured) {
    return NextResponse.json({ error: 'Хранилище видео не настроено — загрузить нельзя' }, { status: 503 });
  }
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? 'Нужны размеры видео и обложки' }, { status: 400 });
  }
  const id = crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(12, '0');
  const key = `videos/tours/${id}.mp4`;
  const poster = `videos/tours/${id}.jpg`;
  try {
    const [uploadUrl, posterUploadUrl] = await Promise.all([
      presignPutUrl(key, 'video/mp4', body.data.videoSize),
      presignPutUrl(poster, 'image/jpeg', body.data.posterSize),
    ]);
    return NextResponse.json({ ok: true, key, poster, uploadUrl, posterUploadUrl, url: s3PublicUrl(key), posterUrl: s3PublicUrl(poster) });
  } catch (err) {
    console.error('[upload/tour-video] ссылку на запись не подписать:', err instanceof Error ? err.message.slice(0, 160) : String(err));
    return NextResponse.json({ error: 'Хранилище не ответило — попробуйте позже' }, { status: 503 });
  }
}
