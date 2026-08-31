/**
 * Готовность хранилища к пакетам карты проверяется ФАКТОМ.
 *
 * 31.08, проба своей карты. Владелец сказал: ключи S3 есть, проверяли
 * загрузкой фото. Для фото этого действительно достаточно — браузер берёт
 * готовую ссылку и качает файл целиком. Пакету карты нужны две вещи, которых
 * загрузка фото не проверяет ВООБЩЕ:
 *
 *   1. публичное чтение без подписи;
 *   2. Range-запросы — PMTiles читает архив кусками, а не целиком.
 *
 * Ответить на это чтением настроек нельзя: «бакет вроде публичный» — не факт,
 * а предположение. Поэтому проверка кладёт пробный объект и читает его
 * по-настоящему.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(
  join(process.cwd(), 'app/api/admin/diagnostics/storage/route.ts'), 'utf-8');

const FN = ROUTE.slice(ROUTE.indexOf('async function checkMapPackReadiness'));

describe('проверка готовности к пакетам карты', () => {
  it('живёт в существующей диагностике хранилища, а не во втором эндпоинте', () => {
    expect(FN.length).toBeGreaterThan(500);
    expect(ROUTE).toContain('map_pack: await checkMapPackReadiness()');
  });

  it('публичное чтение проверяется НЕаутентифицированным запросом', () => {
    // Клиент S3 подписал бы запрос своими ключами и ответил «ok» даже на
    // закрытом бакете — то есть проверял бы не то, что нужно карте.
    expect(FN).toMatch(/await fetch\(url, \{ cache: 'no-store' \}\)/);
  });

  it('Range проверяется по СОДЕРЖИМОМУ, а не по статусу', () => {
    // Хранилище может ответить 206 и прислать файл целиком. Сверяем, что
    // пришли ровно запрошенные байты из середины.
    expect(FN).toMatch(/Range: 'bytes=10-19'/);
    expect(FN).toContain('body.subarray(10, 20)');
    expect(FN).toMatch(/ranged\.status === 206 && got\.equals\(expected\)/);
  });

  it('проба удаляется при ЛЮБОМ исходе', () => {
    // Диагностика, засоряющая бакет, — та же болезнь, что «Удалить регион»,
    // которое ничего не удаляло (22.08).
    const tail = FN.slice(FN.indexOf('} finally {'));
    expect(tail).toContain('deleteFromS3(key)');
  });

  it('отказ проверки не выдаётся за успех', () => {
    // §4.0: третий исход — «не смог проверить», и он не равен «хорошо».
    expect(FN).toContain('не смог проверить');
    expect(FN).toMatch(/Это НЕ значит, что всё в порядке/);
  });

  it('подсказывает готовое значение переменной, а не описание формата', () => {
    // Владелец спросил «где взять» — ответ должен быть строкой, которую
    // копируют, а не инструкцией по сборке адреса.
    expect(FN).toContain('base_url_to_set');
    expect(FN).toMatch(/const baseUrl = `\$\{endpoint\}\/\$\{bucket\}`/);
    // И сразу говорит, совпадает ли уже заданное с ожидаемым.
    expect(FN).toContain('base_url_matches');
  });

  it('вердикт замечает уже сделанный шаг', () => {
    // Первая редакция звала задать переменную ВСЕГДА и продолжала звать
    // после того, как её задали. Совет, не видящий выполненного, обесценивает
    // и остальные свои советы.
    expect(FN).toContain('const baseReady = result.base_url_matches === true');
    const at = FN.indexOf('result.verdict = rangeOk');
    expect(FN.slice(at, at + 400)).toContain('baseReady');
  });

  it('база адреса не дублирует префикс ключа', () => {
    // packKey уже отдаёт `map-packs/...`; база с тем же префиксом дала бы
    // `map-packs/map-packs/...` и 404 в поле.
    expect(FN).not.toMatch(/baseUrl = .*map-packs/);
  });
});
