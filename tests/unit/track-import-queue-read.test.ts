/**
 * Загруженные треки должно быть чем СНЯТЬ — сторож пути чтения.
 *
 * Та же болезнь, что field-check-queue-read.test.ts уже стережёт для
 * route_field_checks, только моложе: route_track_imports (миграция 904,
 * позже 898 — миграции очереди проверок) писала POST /api/field-check/track
 * и не читалась НИ ОДНИМ файлом в репозитории. Обнаружено 24.08 — владелец
 * спросил, сняли ли знакомые трек в поле, и ответить было нечем: не потому
 * что треков нет, а потому что смотреть было некуда.
 *
 * Черты, которые здесь стерегутся:
 *  1. Путь чтения существует и остаётся READ-ONLY — разбор решает человек.
 *  2. Рядом с треком стоит найденное совпадение с нашим маршрутом и
 *     расхождение в километрах, а не голое «привязали/не привязали».
 *  3. Ссылка на файл в S3 отдаётся — без неё разбор нечем начать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queue = readFileSync(
  join(process.cwd(), 'app/api/cron/track-import-queue/route.ts'), 'utf-8');

describe('очередь загруженных треков — чтение', () => {
  it('очередь читается и ничего не меняет', () => {
    expect(queue).toContain('FROM route_track_imports');
    expect(queue).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  it('секрет сравнивается за постоянное время', () => {
    expect(queue).toContain('timingSafeCompare');
    expect(queue).not.toMatch(/CRON_SECRET\}`/);
  });

  it('запрос параметризован — статус и предел не склеиваются в текст', () => {
    expect(queue).toMatch(/\[status, limit\]/);
    expect(queue).toMatch(/\$1 = 'all' OR t\.status = \$1/);
  });

  it('статус и предел не принимаются на веру', () => {
    expect(queue).toMatch(/\['pending', 'applied', 'rejected', 'all'\]\.includes/);
    expect(queue).toMatch(/Math\.min\(100, Math\.max\(1, rawLimit\)\)/);
  });

  it('рядом с треком стоит совпадение с нашим маршрутом и расхождение', () => {
    expect(queue).toContain('matched_route_title');
    expect(queue).toContain('off_by_km');
    expect(queue).toContain('LEFT JOIN kamchatka_routes');
  });

  it('файл отдаётся ссылкой, а не перекачивается через себя', () => {
    expect(queue).toContain('s3_url');
  });

  it('непривязанный трек — отдельный счёт, а не молчание', () => {
    expect(queue).toContain('unmatched');
    expect(queue).toContain('matched');
  });
});
