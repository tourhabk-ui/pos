/**
 * POST /api/upload/tour-video — видео своего тура с обложкой (05.11, слово
 * владельца «да делай» на видео к туру гида).
 *
 * До этого дня клип тура (миграция 1194) появлялся только миграцией: пути у
 * гида и оператора не было вовсе. Гид Андрей Запорожец: «добавить фото видео
 * к туру (в первую очередь нужно)».
 *
 * FormData: `file` — MP4 до 100 МБ, `poster` — JPEG-кадр до 2 МБ (кадр
 * снимает браузер гида: ffmpeg на проде нет). Тип проверяется по байтам, а
 * не по имени: MP4 — `ftyp` на 4-м байте, JPEG — FF D8 FF. Ключи — по
 * содержимому (`videos/tours/<sha256-12>.mp4|.jpg`), их принимает правка тура
 * (`OWN_CLIP_KEY`, lib/guides/own-tour-edit). Без хранилища — 503 с причиной:
 * файл в контейнере исчез бы при следующем выкате.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireRole } from '@/lib/auth/middleware';
import { isS3Configured, uploadToS3, s3PublicUrl } from '@/lib/storage/s3';

export const dynamic = 'force-dynamic';

/** Предел видео: файл целиком читается в память контейнера (4 ГБ на всё). */
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const POSTER_MAX_BYTES = 2 * 1024 * 1024;

function isMp4(b: Uint8Array): boolean {
  return b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide', 'operator', 'admin']);
  if (auth instanceof NextResponse) return auth;

  if (!isS3Configured) {
    return NextResponse.json({ error: 'Хранилище видео не настроено — загрузить нельзя' }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Файл не дошёл — попробуйте ещё раз' }, { status: 400 });
  }
  const file = form.get('file');
  const poster = form.get('poster');
  if (!(file instanceof File) || !(poster instanceof File)) {
    return NextResponse.json({ error: 'Нужны видео и кадр-обложка' }, { status: 400 });
  }
  if (file.size > VIDEO_MAX_BYTES) {
    return NextResponse.json({ error: 'Видео больше 100 МБ — укоротите ролик или сожмите его' }, { status: 400 });
  }
  if (poster.size > POSTER_MAX_BYTES) {
    return NextResponse.json({ error: 'Обложка больше 2 МБ' }, { status: 400 });
  }

  const video = Buffer.from(await file.arrayBuffer());
  const cover = Buffer.from(await poster.arrayBuffer());
  if (!isMp4(video)) {
    return NextResponse.json({ error: 'Нужен файл MP4 — так снимает большинство телефонов' }, { status: 400 });
  }
  if (!isJpeg(cover)) {
    return NextResponse.json({ error: 'Обложка — только JPEG' }, { status: 400 });
  }

  const hash = crypto.createHash('sha256').update(video).digest('hex').slice(0, 12);
  const key = `videos/tours/${hash}.mp4`;
  const posterKey = `videos/tours/${hash}.jpg`;
  try {
    await uploadToS3(key, video, 'video/mp4');
    await uploadToS3(posterKey, cover, 'image/jpeg');
  } catch (err) {
    console.error('[upload/tour-video] хранилище не приняло файл:', err instanceof Error ? err.message.slice(0, 160) : String(err));
    return NextResponse.json({ error: 'Хранилище не приняло видео — попробуйте позже' }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    key,
    poster: posterKey,
    url: s3PublicUrl(key),
    posterUrl: s3PublicUrl(posterKey),
    sizeMb: Math.round(video.length / 1024 / 1024),
  });
}
