/**
 * lib/storage/s3.ts
 *
 * Централизованный сервис для работы с S3 (Timeweb Object Storage).
 * Поддерживает upload, getPublicUrl, delete.
 * Если S3 не настроен — fallback на локальную файловую систему (/tmp).
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';

// ── Config ───────────────────────────────────────────────────────────────────

const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || '';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || '';
const S3_ENDPOINT   = process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru';
const S3_BUCKET     = process.env.S3_BUCKET || '';
const S3_REGION     = process.env.S3_REGION || 'ru-1';

/** S3 настроен и готов к использованию? */
export const isS3Configured = !!(S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET);

// ── Client (lazy singleton) ──────────────────────────────────────────────────

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    if (!isS3Configured) {
      throw new Error('S3 not configured: S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET required');
    }
    _client = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
      },
      forcePathStyle: true,
      // AWS SDK с 3.729 по умолчанию шлёт checksum-заголовки
      // (x-amz-checksum-crc32) и aws-chunked-кодирование, которые
      // S3-совместимые хранилища не принимают — Timeweb отвечал ошибкой на
      // КАЖДУЮ запись, наружу это выходило как «UnknownError» (диагностика
      // 06.08, write_test). WHEN_REQUIRED возвращает поведение классического
      // S3-клиента: контрольные суммы только там, где их требует операция.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return _client;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface UploadResult {
  /** Полный публичный URL файла */
  url: string;
  /** Ключ объекта в бакете (для удаления) */
  key: string;
  /** Размер в байтах */
  size: number;
}

// ── Upload ───────────────────────────────────────────────────────────────────

/**
 * Загрузить файл в S3.
 *
 * @param key — путь в бакете (напр. "images/hero/volcano.jpg")
 * @param body — содержимое файла
 * @param contentType — MIME-тип (напр. "image/jpeg")
 * @returns публичный URL и ключ
 */
export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
  // Год и immutable — для фото и видео: у них новый файл — новый ключ. Файлы
  // пакетов карты живут под постоянным ключом и читаются кусками — у них
  // своя политика (lib/map/pack-cache-policy.ts), и заливка её передаёт.
  cacheControl: string = 'public, max-age=31536000, immutable',
): Promise<UploadResult> {
  const client = getClient();

  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ACL: 'public-read',
      CacheControl: cacheControl,
    }),
  );

  return {
    url: `${S3_ENDPOINT}/${S3_BUCKET}/${key}`,
    key,
    size: body.length,
  };
}

/**
 * Переписать заголовки объекта на месте, не перекачивая тело: копия объекта
 * в самого себя с MetadataDirective REPLACE. S3 при REPLACE забывает и
 * Content-Type, и ACL — поэтому оба задаются заново, а не «остаются».
 */
export async function restampObject(key: string, contentType: string, cacheControl: string): Promise<void> {
  const client = getClient();
  await client.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      CopySource: `${S3_BUCKET}/${key}`,
      MetadataDirective: 'REPLACE',
      ContentType: contentType,
      CacheControl: cacheControl,
      ACL: 'public-read',
    }),
  );
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * Удалить объект из S3.
 */
export async function deleteFromS3(key: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );
}

// ── Public URL helper ────────────────────────────────────────────────────────

// getS3PublicUrl убрана 22.08.2026 (перепись): адрес файла собирают там, где
// он и появляется — при загрузке, из ответа хранилища.
