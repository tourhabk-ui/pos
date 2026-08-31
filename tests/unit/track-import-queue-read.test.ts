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
 * 30.08: владелец захотел не только смотреть, но и ПРИМЕНИТЬ снятый трек как
 * geometry конкретного маршрута — добавлен POST (см. describe ниже). GET
 * остаётся отдельным путём и по-прежнему обязан быть чтением: сторож ниже
 * проверяет ИМЕННО тело GET, а не файл целиком.
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

/** Тело именно GET — от объявления функции до объявления POST. */
const getBody = queue.slice(
  queue.indexOf('export async function GET'),
  queue.indexOf('export async function POST'),
);

describe('очередь загруженных треков — чтение', () => {
  it('GET читается и ничего не меняет', () => {
    expect(getBody).toContain('FROM route_track_imports');
    expect(getBody).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
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

/** Тело POST вместе со схемой тела запроса — от WEAK_SOURCES до конца файла. */
const postBody = queue.slice(queue.indexOf('const WEAK_SOURCES'));

describe('очередь загруженных треков — применение (POST, 30.08)', () => {
  it('POST существует и защищён тем же секретом', () => {
    expect(postBody.length).toBeGreaterThan(500);
    expect(postBody).toContain('timingSafeCompare');
  });

  it('цель называется явно — matched_route_id из очереди НЕ используется как источник цели', () => {
    // Сам матчинг в POST /api/field-check/track подбирает ближайшую запись
    // геометрией, а не тем маршрутом, которым человек фактически шёл —
    // владелец 30.08 получил другую запись в matched_route_id, чем
    // «Зеленовские озерки», которые называл сам. Применение обязано брать
    // цель из явного route_id/route_title тела запроса.
    expect(postBody).toMatch(/route_id:\s*z\.string/);
    expect(postBody).toMatch(/route_title:\s*z\.string/);
    expect(postBody).toMatch(/\.refine\(/);
    // Разрешение цели — ТОЛЬКО по data.route_id/data.route_title, не по
    // matched_route_id из очереди (строка ниже в тексте отказа объясняет
    // это человеку, а не используется как значение для запроса).
    const routeResBlock = postBody.slice(
      postBody.indexOf('const routeRes'), postBody.indexOf('const target ='),
    );
    expect(routeResBlock).not.toMatch(/matched_route_id/);
    expect(routeResBlock).toMatch(/data\.route_id/);
    expect(routeResBlock).toMatch(/data\.route_title/);
  });

  it('сухой прогон по умолчанию — dry_run: true', () => {
    expect(postBody).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
    expect(postBody).toMatch(/if \(data\.dry_run\)/);
  });

  it('применить можно только запись в статусе pending — не дважды', () => {
    expect(postBody).toMatch(/queued\.status !== 'pending'/);
  });

  it('точки за пределами Камчатки отсеиваются той же проверкой, что и живой след', () => {
    expect(queue).toContain("from '@/lib/routes/track'");
    expect(postBody).toContain('isPlausibleTrackPoint');
  });

  it('существующую сильную геометрию молча не заменяет — нужен force', () => {
    expect(postBody).toMatch(/WEAK_SOURCES/);
    expect(postBody).toMatch(/targetIsStrong && !data\.force/);
  });

  it('запись в базу идёт транзакцией — geometry и статус очереди меняются вместе', () => {
    const applyAt = postBody.indexOf('pool.connect()');
    expect(applyAt).toBeGreaterThan(0);
    const txBlock = postBody.slice(applyAt, postBody.indexOf('client.release()'));
    expect(txBlock).toContain("client.query('BEGIN')");
    expect(txBlock).toContain('UPDATE kamchatka_routes');
    expect(txBlock).toContain("UPDATE route_track_imports SET status = 'applied'");
    expect(txBlock).toContain("client.query('COMMIT')");
    expect(txBlock).toContain("client.query('ROLLBACK')");
  });

  it('новая линия помечена source: gpx — снятый трек, не набросок', () => {
    expect(postBody).toMatch(/'source',\s*'gpx'/);
  });
});
