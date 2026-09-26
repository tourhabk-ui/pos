import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { isS3Configured, uploadToS3 } from '@/lib/storage/s3';
import { sniffImage } from '@/lib/storage/image-sniff';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 5 * 1024 * 1024;

/**
 * POST /api/upload - Загрузка изображений (фото объектов жилья).
 * AUTH: requireAuth — только авторизованные пользователи
 * Storage: S3 (production) → public/uploads/ (dev fallback)
 *
 * Тип файла определяется по БАЙТАМ (lib/storage/image-sniff), а не по
 * заявленному MIME и не по имени: до 26.09 сюда можно было положить SVG
 * (документ со скриптами, отданный с нашего хранилища) или что угодно под
 * расширением из имени. Разрешены JPEG, PNG, WebP; расширение и Content-Type
 * берутся из распознанного типа. Не-картинка — отказ с именем файла, а не
 * молчаливый пропуск: «загружено 0 из 1» при ответе «успешно» — это
 * «хорошо» вместо «не смог» (§4.0).
 *
 * Единственный вызывающий на 26.09 — фото объекта жилья
 * (app/hub/stay/accommodations/[id]/photos). Фото туров идут своим
 * /api/upload/tour-photo.
 */
export async function POST(request: NextRequest) {
  const userOrResponse = await requireAuth(request);
  if (userOrResponse instanceof NextResponse) return userOrResponse;

  // Без S3 на проде файл лёг бы в файловую систему контейнера и исчез при
  // следующем деплое — честный отказ вместо тихой потери (как в tour-photo).
  if (!isS3Configured && process.env.NODE_ENV === 'production') {
    return NextResponse.json({
      success: false,
      error: 'Хранилище фото не настроено: без S3 файл исчез бы при следующем деплое',
    } as ApiResponse<null>, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' } as ApiResponse<null>, { status: 400 });
  }

  const files = formData.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (files.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'Файлы не найдены'
    } as ApiResponse<null>, { status: 400 });
  }

  // Сначала проверяются ВСЕ файлы, потом пишется хоть один: частичная
  // загрузка с ответом «ошибка» оставила бы в хранилище сирот.
  const prepared: { buffer: Buffer; mime: string; ext: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_SIZE) {
      return NextResponse.json({
        success: false,
        error: `Файл «${file.name}» слишком большой (максимум 5 МБ)`
      } as ApiResponse<null>, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffImage(buffer);
    if (!sniffed) {
      return NextResponse.json({
        success: false,
        error: `Файл «${file.name}» — не JPEG, PNG или WebP. Загрузите фотографию в одном из этих форматов.`
      } as ApiResponse<null>, { status: 400 });
    }
    prepared.push({ buffer, mime: sniffed.mime, ext: sniffed.ext });
  }

  try {
    const uploadedFiles: string[] = [];
    for (const { buffer, mime, ext } of prepared) {
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

      if (isS3Configured) {
        const result = await uploadToS3(`uploads/${filename}`, buffer, mime);
        uploadedFiles.push(result.url);
      } else {
        const uploadDir = join(process.cwd(), 'public', 'uploads');
        await mkdir(uploadDir, { recursive: true });
        await writeFile(join(uploadDir, filename), buffer);
        uploadedFiles.push(`/uploads/${filename}`);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        files: uploadedFiles,
        count: uploadedFiles.length
      },
      message: 'Файлы успешно загружены'
    } as ApiResponse<unknown>);

  } catch (error) {
    console.error('[upload] запись файла не выполнилась:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({
      success: false,
      error: 'Ошибка при загрузке файлов'
    } as ApiResponse<null>, { status: 500 });
  }
}
