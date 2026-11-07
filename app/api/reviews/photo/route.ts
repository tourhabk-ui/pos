/**
 * POST /api/reviews/photo — фото туриста для отзыва о туре.
 *
 * FormData: file (изображение), tour_id (числовой id operator_tours).
 *
 * Гейт тот же, что у самого отзыва: загрузить фото может только человек с
 * ЗАВЕРШЁННОЙ бронью этого тура — чужие люди не заливают в наше хранилище.
 * Без S3 на проде — честный отказ (файл в контейнере умер бы при деплое).
 *
 * Снимок пишется не как прислан (владелец 07.11: «адаптируй загрузку
 * фото»): фото отзыва публичное, а EXIF с телефона несёт место съёмки —
 * где был человек. Разворот по EXIF, длинная сторона до 2048 точек, JPEG без
 * метаданных (lib/images/upload-photo.ts). Не разобрался — отказ, а не
 * исходник с геометкой в хранилище.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { isS3Configured, uploadToS3 } from '@/lib/storage/s3';
import { redactPII } from '@/lib/security/pii-redact';
import { preparePhoto, photoRefusal, uploadBodyTooLarge, UPLOAD_PHOTO_MAX_BYTES, PHOTO_TOO_LARGE } from '@/lib/images/upload-photo';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const MAX_SIZE = UPLOAD_PHOTO_MAX_BYTES;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const userId = authResult.userId;

  if (!isS3Configured && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Хранилище фото не настроено — загрузка отключена. Проверка: GET /api/admin/diagnostics/storage' },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    if (uploadBodyTooLarge(request)) return NextResponse.json({ error: PHOTO_TOO_LARGE }, { status: 413 });
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }

  const file = formData.get('file');
  const tourId = parseInt(String(formData.get('tour_id') ?? ''));
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Поле file обязательно' }, { status: 400 });
  }
  if (isNaN(tourId)) {
    return NextResponse.json({ error: 'Поле tour_id обязательно' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type) && !file.name.match(/\.(jpg|jpeg|png|webp|heic)$/i)) {
    return NextResponse.json({ error: 'Допустимые форматы: JPG, PNG, WebP' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: PHOTO_TOO_LARGE }, { status: 400 });
  }

  // Тот же гейт, что у отзыва: фото — только у реально съездившего.
  const bookingCheck = await query(
    `SELECT id FROM operator_bookings
     WHERE user_id = $1
     AND operator_tour_id = $2
     AND booking_status = 'completed'
     AND deleted_at IS NULL
     LIMIT 1`,
    [userId, tourId]
  );
  if (bookingCheck.rows.length === 0) {
    return NextResponse.json(
      { error: 'Фото к отзыву можно добавить только после завершения тура' },
      { status: 403 },
    );
  }

  const prepared = await preparePhoto(Buffer.from(await file.arrayBuffer()));
  if (!prepared.ok) {
    console.error('[reviews/photo] снимок не разобрался:', file.type || 'тип не указан', prepared.reason);
    return NextResponse.json({ error: photoRefusal(file.type, file.name) }, { status: 400 });
  }

  try {
    const buffer = prepared.buf;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const key = `reviews/${hash}.${prepared.ext}`;

    if (isS3Configured) {
      const { url } = await uploadToS3(key, buffer, prepared.mime);
      return NextResponse.json({ ok: true, url });
    }

    // Локальная разработка без S3: файл не сохраняем, а честно говорим об этом.
    return NextResponse.json(
      { error: 'S3 не настроен локально — фото отзыва некуда сохранить' },
      { status: 503 },
    );
  } catch (err) {
    const msg = err instanceof Error ? redactPII(err.message).slice(0, 200) : 'Неизвестная ошибка';
    return NextResponse.json({ error: `Не удалось загрузить фото: ${msg}` }, { status: 500 });
  }
}
