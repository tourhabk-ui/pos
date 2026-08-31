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
    // Имя бакета — НЕ секрет: нужно сверить глазами, в тот ли бакет пишет
    // приложение (владелец 07.08 смотрел на пустой бакет и не понимал, туда ли
    // уходят загрузки). Ключи по-прежнему только флагами.
    bucket: process.env.S3_BUCKET || null,
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
  // ?keep=1 — НЕ удалять тест-объект: чтобы владелец увидел, как файл реально
  // появляется в бакете (0 ГБ пугает, а загрузка сама себя удаляла). Файл
  // крошечный (4 байта), можно удалить вручную из панели.
  const keep = new URL(request.url).searchParams.get('keep') === '1';
  const testKey = `diagnostics/storage-ping-${Date.now()}.txt`;
  try {
    const { url } = await uploadToS3(testKey, Buffer.from('ping'), 'text/plain');
    if (!keep) await deleteFromS3(testKey).catch(() => { /* мусор в бакете не критичен */ });
    return NextResponse.json({
      success: true,
      ...flags,
      write_test: 'ok',
      // При keep=1 — ссылка на записанный файл: открой её и увидишь «ping»,
      // а в дашборде бакета появится этот объект (объём перестанет быть 0 ГБ).
      test_object: keep ? url : null,
      map_pack: await checkMapPackReadiness(),
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

/**
 * Готово ли хранилище к пакетам своей карты (проба 31.08).
 *
 * Записи фото недостаточно: пакетам нужны ДВЕ вещи, которых загрузка
 * фотографий не проверяет, потому что фото читаются браузером целиком и по
 * готовой ссылке из БД.
 *
 *  1. ПУБЛИЧНОЕ чтение без подписи — карта тянет пакет прямо из бакета;
 *  2. Range-запросы — PMTiles берёт КУСКИ архива. Без Range читатель либо
 *     скачает все 10 МБ ради одного тайла, либо не заработает вовсе.
 *
 * Проверяется фактом, а не чтением настроек: кладём пробный объект, читаем
 * его НЕаутентифицированным fetch, затем просим 10 байт из середины и
 * сверяем, что пришли ровно они. Проба удаляется в `finally` — след не
 * остаётся по построению, а не по удаче (тот же приём, что у beacon-check).
 */
async function checkMapPackReadiness(): Promise<Record<string, unknown>> {
  const endpoint = process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru';
  const bucket = process.env.S3_BUCKET || '';
  // Ровно та строка, которую надо вписать в NEXT_PUBLIC_MAP_PACK_BASE_URL:
  // ключ объекта (`map-packs/...`) добавляет packKey, дублировать не нужно.
  const baseUrl = `${endpoint}/${bucket}`;
  const configured = process.env.NEXT_PUBLIC_MAP_PACK_BASE_URL || null;

  // 64 байта с несекретным узнаваемым содержимым: по нему видно, что Range
  // отдал именно запрошенный кусок, а не начало файла.
  const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?');
  const key = `diagnostics/map-pack-range-probe-${Date.now()}.bin`;
  const result: Record<string, unknown> = {
    base_url_to_set: baseUrl,
    base_url_configured: configured,
    base_url_matches: configured ? configured.replace(/\/+$/, '') === baseUrl : null,
  };

  try {
    const { url } = await uploadToS3(key, body, 'application/octet-stream');

    // 1. Публичное чтение — без единого заголовка авторизации.
    const plain = await fetch(url, { cache: 'no-store' });
    result.public_read = plain.ok ? 'ok' : `HTTP ${plain.status}`;
    if (!plain.ok) {
      result.verdict = 'Бакет НЕ открыт на публичное чтение — карта не сможет '
        + 'взять пакет. Включите публичный доступ к бакету в панели Timeweb.';
      return result;
    }

    // 2. Range — сердце PMTiles.
    const ranged = await fetch(url, {
      headers: { Range: 'bytes=10-19' }, cache: 'no-store',
    });
    const got = Buffer.from(await ranged.arrayBuffer());
    const expected = body.subarray(10, 20);
    const rangeOk = ranged.status === 206 && got.equals(expected);
    result.range_status = ranged.status;
    result.range_bytes = got.length;
    result.range_read = rangeOk ? 'ok' : 'нет';
    result.verdict = rangeOk
      ? 'Хранилище готово к пакетам карты: публичное чтение и Range работают. '
        + 'Осталось задать NEXT_PUBLIC_MAP_PACK_BASE_URL значением base_url_to_set.'
      : `Range-запросы не поддержаны (статус ${ranged.status}, пришло `
        + `${got.length} байт вместо 10). PMTiles читает архив кусками — без Range `
        + 'пакет либо качается целиком, либо не открывается.';
    return result;
  } catch (e) {
    const err = e as Error;
    // Отказ проверки — это «не смог проверить», а не «всё хорошо» (§4.0).
    result.public_read = 'не смог проверить';
    result.error = redactPII(`${err.name}: ${err.message}`).slice(0, 300);
    result.verdict = 'Проверку готовности к пакетам карты выполнить не удалось — '
      + 'смотрите error. Это НЕ значит, что всё в порядке.';
    return result;
  } finally {
    // Проба не остаётся в бакете ни при каком исходе.
    await deleteFromS3(key).catch(() => { /* уже сказано выше, не глушим смысл */ });
  }
}
