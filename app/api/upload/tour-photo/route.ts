/**
 * POST /api/upload/tour-photo
 * Upload a photo file for a tour. Accessible by operator, admin and guide roles.
 * Returns the saved path that can be used as a tour photo URL.
 *
 * FormData fields:
 *   file — image file (jpg/png/webp)
 *
 * Снимок пишется не как прислан (владелец 07.11: «Да, делай»): разворот по
 * EXIF, длинная сторона до 2048 точек, JPEG без метаданных — места съёмки в
 * файле нет (lib/images/upload-photo.ts). Не разобрался — отказ с причиной, а
 * не исходник с геометкой в хранилище.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { isS3Configured, uploadToS3 } from '@/lib/storage/s3';
import { preparePhoto, photoRefusal, UPLOAD_PHOTO_MAX_BYTES, UPLOAD_PHOTO_MAX_MB } from '@/lib/images/upload-photo';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const MAX_SIZE = UPLOAD_PHOTO_MAX_BYTES;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export async function POST(request: NextRequest) {
  const authOrResponse = await requireRole(request, ['operator', 'admin', 'guide']);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Поле file обязательно' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type) && !file.name.match(/\.(jpg|jpeg|png|webp|heic)$/i)) {
    return NextResponse.json({ error: 'Допустимые форматы: JPG, PNG, WebP' }, { status: 400 });
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: `Файл слишком большой (макс. ${UPLOAD_PHOTO_MAX_MB} МБ)` }, { status: 400 });
  }

  // Без S3 на проде фото легло бы в файловую систему контейнера и молча
  // исчезло при следующем деплое (а их по несколько в день). Владелец 06.08:
  // «фото не добавляются через модерацию» — именно так выглядит эфемерная
  // запись снаружи. Честный отказ с причиной вместо тихой потери; локальная
  // разработка живёт на файловом фоллбэке как раньше.
  if (!isS3Configured && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error:
          'Хранилище фото не настроено: без S3 файл исчез бы при следующем деплое. ' +
          'Добавьте S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (Timeweb Object Storage) ' +
          'в переменные приложения. Проверка: GET /api/admin/diagnostics/storage',
      },
      { status: 503 },
    );
  }

  const prepared = await preparePhoto(Buffer.from(await file.arrayBuffer()));
  if (!prepared.ok) {
    console.error('[upload/tour-photo] снимок не разобрался:', file.type || 'тип не указан', prepared.reason);
    return NextResponse.json({ error: photoRefusal(file.type, file.name) }, { status: 400 });
  }

  try {
    const buffer = prepared.buf;

    // Safe filename: hash-based to avoid collisions. Всегда .jpg: после
    // подготовки это JPEG, какой бы файл ни прислали.
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const safeName = `tour_${hash}.jpg`;
    const s3Key = `images/tours/${safeName}`;

    let servePath: string;

    if (isS3Configured) {
      const result = await uploadToS3(s3Key, buffer, 'image/jpeg');
      servePath = result.url;
    } else {
      const toursDir = path.join(process.cwd(), 'public', 'images', 'tours');
      const tmpDir = path.join('/tmp', 'tourhab-uploads', 'images', 'tours');

      let outDir = toursDir;
      servePath = `/images/tours/${safeName}`;

      try {
        await fs.mkdir(toursDir, { recursive: true });
        await fs.access(toursDir, 2 /* W_OK */);
      } catch {
        outDir = tmpDir;
        servePath = `/api/photos/images/tours/${safeName}`;
        await fs.mkdir(tmpDir, { recursive: true });
      }

      await fs.writeFile(path.join(outDir, safeName), buffer);
    }

    return NextResponse.json({
      ok: true,
      url: servePath,
      filename: safeName,
      sizeKb: Math.round(buffer.length / 1024),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
