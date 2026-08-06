/**
 * GET /api/admin/diagnostics/storage — живое состояние хранилища фото.
 *
 * Владелец 06.08: «фото не добавляются через модерацию». Без S3 загрузка
 * писала в файловую систему контейнера — фото жило до следующего деплоя и
 * исчезало молча. Этот эндпоинт отвечает на вопрос «настроен ли S3 на самом
 * деле» фактом: не чтением env, а реальной записью и удалением тест-объекта.
 * Значения ключей наружу не выходят — только флаги «задан/не задан».
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { isS3Configured, uploadToS3, deleteFromS3 } from '@/lib/storage/s3';
import { redactPII } from '@/lib/security/pii-redact';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const flags = {
    s3_configured: isS3Configured,
    access_key_set: !!process.env.S3_ACCESS_KEY,
    secret_key_set: !!process.env.S3_SECRET_KEY,
    bucket_set: !!process.env.S3_BUCKET,
    endpoint: process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru (по умолчанию)',
  };

  if (!isS3Configured) {
    return NextResponse.json({
      success: true,
      ...flags,
      write_test: null,
      verdict:
        'S3 не настроен — загрузка фото на проде отключена (иначе файлы исчезали бы ' +
        'при каждом деплое). Нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET в панели Timeweb.',
    });
  }

  // Ключи могут быть заданы, но неверны — проверяем фактом записи.
  const testKey = `diagnostics/storage-ping-${Date.now()}.txt`;
  try {
    await uploadToS3(testKey, Buffer.from('ping'), 'text/plain');
    await deleteFromS3(testKey).catch(() => { /* мусор в бакете не критичен */ });
    return NextResponse.json({
      success: true,
      ...flags,
      write_test: 'ok',
      verdict: 'S3 работает: тест-объект записан и удалён. Загрузка фото должна работать.',
    });
  } catch (e) {
    // «UnknownError» без деталей уже стоил круга диагностики (06.08) — имя,
    // HTTP-статус и текст ответа хранилища выносим наружу целиком.
    const err = e as Error & { $metadata?: { httpStatusCode?: number }; Code?: string };
    const detail = [
      err.name,
      err.Code && err.Code !== err.name ? err.Code : null,
      err.$metadata?.httpStatusCode ? `HTTP ${err.$metadata.httpStatusCode}` : null,
      err.message && err.message !== err.name ? err.message : null,
    ].filter(Boolean).join(' · ');
    return NextResponse.json({
      success: true,
      ...flags,
      write_test: redactPII(detail || 'ошибка записи').slice(0, 300),
      verdict:
        'Ключи S3 заданы, но запись не прошла — проверьте значения ключей, имя бакета ' +
        'и права доступа в Timeweb Object Storage.',
    });
  }
}
