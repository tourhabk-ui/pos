/**
 * POST /api/hub/operator/upload
 * Загружает фото тура в S3. Возвращает публичный URL.
 * Auth: operator или admin.
 * Limit: 20 MB до подготовки, только JPEG, PNG, WebP.
 *
 * Снимок пишется не как прислан (владелец 07.11: «адаптируй загрузку
 * фото»): разворот по EXIF, длинная сторона до 2048 точек, JPEG без
 * метаданных — места съёмки в файле нет (lib/images/upload-photo.ts).
 * Предел поднят с 5 МБ: обычный снимок с телефона тяжелее, а хранится
 * уже подготовленный.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { preparePhoto, photoRefusal, UPLOAD_PHOTO_MAX_BYTES, UPLOAD_PHOTO_MAX_MB } from '@/lib/images/upload-photo';

export const dynamic = 'force-dynamic';

const MAX_SIZE = UPLOAD_PHOTO_MAX_BYTES;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function POST(request: NextRequest) {
  const authOrResponse = await requireOperator(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  if (!isS3Configured) {
    return NextResponse.json(
      { success: false, error: 'Хранилище не настроено. Обратитесь к администратору.' },
      { status: 503 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный запрос' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'Файл не передан' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { success: false, error: 'Допустимы только JPEG, PNG, WebP' },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_SIZE) {
    return NextResponse.json(
      { success: false, error: `Файл слишком большой. Максимум ${UPLOAD_PHOTO_MAX_MB} МБ.` },
      { status: 400 }
    );
  }

  const prepared = await preparePhoto(buffer);
  if (!prepared.ok) {
    console.error('[hub/operator/upload] снимок не разобрался:', file.type, prepared.reason);
    return NextResponse.json({ success: false, error: photoRefusal(file.type, file.name) }, { status: 400 });
  }

  const key = `tours/${authOrResponse.userId}/${Date.now()}.${prepared.ext}`;

  try {
    const result = await uploadToS3(key, prepared.buf, prepared.mime);
    return NextResponse.json({ success: true, url: result.url });
  } catch (err) {
    console.error('[hub/operator/upload] хранилище не приняло файл:', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки. Попробуйте ещё раз.' },
      { status: 500 }
    );
  }
}
