/**
 * POST /api/reviews/photo — фото туриста для отзыва о туре.
 *
 * FormData: file (изображение), tour_id (числовой id operator_tours).
 *
 * Гейт тот же, что у самого отзыва: загрузить фото может только человек с
 * ЗАВЕРШЁННОЙ бронью этого тура — чужие люди не заливают в наше хранилище.
 * Без S3 на проде — честный отказ (файл в контейнере умер бы при деплое).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { isS3Configured, uploadToS3 } from '@/lib/storage/s3';
import { redactPII } from '@/lib/security/pii-redact';
import crypto from 'crypto';
import path from 'path';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 10 * 1024 * 1024; // 10 МБ
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
    return NextResponse.json({ error: 'Файл слишком большой (макс. 10 МБ)' }, { status: 400 });
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

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const ext = path.extname(file.name).toLowerCase().replace('.jpeg', '.jpg') || '.jpg';
    const key = `reviews/${hash}${ext}`;

    if (isS3Configured) {
      const { url } = await uploadToS3(key, buffer, file.type || 'image/jpeg');
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
