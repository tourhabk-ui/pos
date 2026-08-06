/**
 * Загрузка фото тура: честный отказ вместо тихой потери.
 *
 * Владелец 06.08: «фото не добавляются через модерацию». Причина: без S3
 * роут писал файл в файловую систему контейнера — фото жило до следующего
 * деплоя (их по несколько в день) и исчезало молча. Снаружи это выглядит
 * ровно как «не добавляются»: добавил → сохранил → через час нет.
 *
 * Контракт: на проде без S3 загрузка отказывает с причиной и подсказкой,
 * куда смотреть; диагностика хранилища проверяет S3 фактом записи, не env.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('роут загрузки фото тура', () => {
  const src = read('app/api/upload/tour-photo/route.ts');

  it('на проде без S3 — отказ с причиной, а не запись в контейнер', () => {
    // Отказ стоит ДО ветки локальной записи и назван по-русски.
    const refuseAt = src.indexOf("NODE_ENV === 'production'");
    const localWriteAt = src.indexOf('fs.writeFile');
    expect(refuseAt, 'нет прод-отказа без S3').toBeGreaterThan(-1);
    expect(localWriteAt).toBeGreaterThan(refuseAt);
    expect(src).toMatch(/исчез/);
    expect(src).toMatch(/diagnostics\/storage/);
  });

  it('локальная разработка сохраняет файловый фоллбэк', () => {
    expect(src).toMatch(/tourhab-uploads|public.*images.*tours/);
  });
});

describe('S3-клиент совместим с Timeweb', () => {
  it('checksum-заголовки нового SDK выключены (WHEN_REQUIRED)', () => {
    // AWS SDK ≥3.729 по умолчанию шлёт x-amz-checksum-crc32 и aws-chunked,
    // которые Timeweb отвергает: КАЖДАЯ запись падала «UnknownError»
    // (диагностика 06.08). Без этих двух опций фото не грузятся вовсе.
    const src = read('lib/storage/s3.ts');
    expect(src).toMatch(/requestChecksumCalculation:\s*'WHEN_REQUIRED'/);
    expect(src).toMatch(/responseChecksumValidation:\s*'WHEN_REQUIRED'/);
  });
});

describe('диагностика хранилища', () => {
  const src = read('app/api/admin/diagnostics/storage/route.ts');

  it('только для админа и без значений ключей в ответе', () => {
    expect(src).toMatch(/requireAdmin/);
    // Наружу уходят только флаги «задан/не задан», не сами значения.
    expect(src).not.toMatch(/process\.env\.S3_ACCESS_KEY[^ )]*\s*(\}|,)\s*\)/);
    expect(src).toMatch(/!!process\.env\.S3_ACCESS_KEY/);
    expect(src).toMatch(/!!process\.env\.S3_SECRET_KEY/);
  });

  it('S3 проверяется фактом записи, а не чтением env', () => {
    expect(src).toMatch(/uploadToS3\(/);
    expect(src).toMatch(/deleteFromS3\(/);
    // Ошибка записи наружу — через redactPII (сообщения SDK бывают болтливы).
    expect(src).toMatch(/redactPII/);
  });
});
