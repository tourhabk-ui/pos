/**
 * Полевую проверку должно быть чем СНЯТЬ — сторож пути чтения.
 *
 * Владелец 22.08: «а как будут сниматься данные?». На момент вопроса —
 * никак: route_field_checks писалась двумя роутами и не читалась ни одним.
 * Форма, чей результат нельзя посмотреть, — способ потерять чужой труд:
 * человек прошёл маршрут, отправил, и всё стало невидимым.
 *
 * Черты, которые здесь стерегутся:
 *  1. Путь чтения существует и остаётся READ-ONLY — разбор решает человек.
 *  2. Рядом с проверкой стоит НАША запись и расхождение в километрах:
 *     «точка не там» без числа — жалоба, с числом — факт.
 *  3. Ненайденная цель считается отдельно, а не молча как обычная.
 *  4. Снимки не тонут в списке, но достаются по id, и целость проверяется.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queue = readFileSync(
  join(process.cwd(), 'app/api/cron/field-check-queue/route.ts'), 'utf-8');
const photo = readFileSync(
  join(process.cwd(), 'app/api/cron/field-check-photo/route.ts'), 'utf-8');

describe('очередь полевых проверок — чтение', () => {
  it('очередь читается и ничего не меняет', () => {
    expect(queue).toContain('FROM route_field_checks');
    expect(queue).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  it('секрет сравнивается за постоянное время', () => {
    expect(queue).toContain('timingSafeCompare');
    expect(photo).toContain('timingSafeCompare');
    expect(queue).not.toMatch(/CRON_SECRET\}`/);
  });

  it('запрос параметризован — статус и предел не склеиваются в текст', () => {
    expect(queue).toMatch(/\[status, limit\]/);
    expect(queue).toMatch(/\$1 = 'all' OR c\.status = \$1/);
  });

  it('статус и предел не принимаются на веру', () => {
    expect(queue).toMatch(/\['pending', 'applied', 'rejected', 'all'\]\.includes/);
    expect(queue).toMatch(/Math\.min\(100, Math\.max\(1, rawLimit\)\)/);
  });

  it('рядом с проверкой стоит наша запись и расхождение', () => {
    expect(queue).toContain('target_title');
    expect(queue).toContain('off_by_km');
    // Маршруты и места лежат в разных таблицах — обе подтягиваются.
    expect(queue).toContain('LEFT JOIN kamchatka_routes');
    expect(queue).toContain('LEFT JOIN places');
  });

  it('расхождение меряется от координаты объекта, если она дана', () => {
    expect(queue).toMatch(/const fromLat = oLat \?\? rLat/);
  });

  it('ненайденная цель — отдельное состояние, а не пустая строка', () => {
    expect(queue).toContain('orphaned');
    // Правило, а не строчка: имя цели берётся из строки БД и остаётся
    // nullable. Подстановка литерала ('—', '') стёрла бы разницу между
    // «цель называется так» и «цели не нашлось».
    const title = /title:([^\n]*),/.exec(queue);
    expect(title).not.toBeNull();
    expect(title![1]).toMatch(/r\.target_title/);
    expect(title![1]).not.toMatch(/(\?\?|\|\|)\s*['"`]/);
  });

  it('снимки не тонут в списке: число и вес, байты — отдельно', () => {
    expect(queue).toContain('photo_kb');
    expect(queue).not.toMatch(/SELECT[\s\S]{0,200}p\.bytes/);
    expect(photo).toContain('FROM route_field_check_photos');
  });

  it('id снимка проверяется как UUID до похода в базу', () => {
    expect(photo).toMatch(/UUID_RE\.test\(id\)/);
  });

  it('целость снимка проверяется, а не предполагается', () => {
    // Черта, а не выражение: снимок теперь может лежать в S3, и тогда
    // байтов в базе нет — «не знаю» вместо ложного «цел».
    expect(photo).toMatch(/intact: row\.bytes === null \? null :/);
    expect(photo).toContain('row.bytes.length === row.byte_size');
  });

  it('снимок из хранилища отдаётся адресом, а не перекачкой через себя', () => {
    expect(photo).toMatch(/NextResponse\.redirect\(row\.s3_url, 302\)/);
  });

  it('очередь отдаёт ссылки на снимки, а не только их число', () => {
    expect(queue).toContain('photo_urls');
    expect(queue).toContain('ARRAY_REMOVE(ARRAY_AGG(s3_url), NULL)');
  });
});
