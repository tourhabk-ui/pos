// @vitest-environment node
/**
 * Актуатор извлечения точек начала/конца: та же дисциплина source/why/
 * dry-run/партия, что у tour-pickup и place-coords, плюс поведенческие
 * проверки раннера — координата парсится кодом, именованная точка без
 * координаты не линкуется, сухой прогон ничего не пишет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/route-endpoints/route.ts'), 'utf-8');
const RUNNER_SRC = readFileSync(join(process.cwd(), 'lib/import/route-endpoints-runner.ts'), 'utf-8');

describe('дисциплина source/why/dry-run/партия', () => {
  it('source и why обязательны без умолчаний', () => {
    expect(SRC).toMatch(/source: z\.string\(\)\.trim\(\)\.min\(3/);
    expect(SRC).toMatch(/why: z\.string\(\)\.trim\(\)\.min\(3/);
  });

  it('сухой прогон по умолчанию', () => {
    expect(SRC).toMatch(/dry_run: z\.boolean\(\)\.default\(true\)/);
  });

  it('партия не больше десяти', () => {
    expect(SRC).toContain('LIVE_BATCH_MAX = 10');
    expect(SRC).toMatch(/z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)\.max\(LIVE_BATCH_MAX\)/);
  });
});

describe('координату переводит код, не модель', () => {
  it('AI вызывается только через callAIWaterfall', () => {
    expect(RUNNER_SRC).toMatch(/import \{ callAIWaterfall \} from '@\/lib\/ai\/providers'/);
    expect(RUNNER_SRC).not.toMatch(/callDeepSeek\(|callGeminiDirect\(|callOpenrouter\(/);
  });

  it('parseDms вызывается на coord_text модели, а не число берётся напрямую', () => {
    expect(RUNNER_SRC).toContain('parseDms(point.coord_text)');
  });
});

describe('не пишет geometry — только точки', () => {
  it('нет записи в kamchatka_routes.geometry', () => {
    expect(RUNNER_SRC).not.toMatch(/SET geometry|geometry\s*=\s*\$/);
  });
});

describe('регрессия 42P08: $1 приведён явно на ОБОИХ употреблениях', () => {
  // Проба 202 (боевой прогон): "$1" голым для id (text) и "$1::uuid" для
  // ark_id в одном VALUES — PostgreSQL не смог согласовать вывод типа,
  // 4 из 18 маршрутов, которым нужно было новое место, ушли в status:'error'
  // с 42P08. Тот же класс дефекта, что и в CLAUDE.md §4.0 (случай 24.08),
  // другая форма запроса (VALUES/ON CONFLICT, не SELECT/WHERE NOT EXISTS).
  it('id вставляется как $1::text, а не голым $1', () => {
    expect(RUNNER_SRC).toMatch(/VALUES \(\$1::text, \$1::uuid,/);
  });
});

describe('регрессия places_shape_check: location_type обязателен', () => {
  // Проба 203 (после фикса 42P08): та же тройка маршрутов ушла в
  // status:'error' с "violates check constraint places_shape_check" —
  // (activity_type IS NULL AND location_type IS NOT NULL), migration 650.
  // 'other' — та же честная заглушка «тип неизвестен», что у
  // kamchatkaland-importer.ts и ELSE-ветки 650_cleanup_places_phase1.sql.
  it('INSERT INTO places задаёт location_type', () => {
    expect(RUNNER_SRC).toMatch(/location_type/);
    expect(RUNNER_SRC).toMatch(/VALUES \(\$1::text, \$1::uuid, \$2, \$3::numeric, \$4::numeric, 'other',/);
  });
});

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

const callAIWaterfallMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callAIWaterfall: (...a: unknown[]) => callAIWaterfallMock(...a) }));

vi.mock('@/app/api/cron/place-coords/route', () => ({
  KRAI_LAT_MIN: 50.0, KRAI_LAT_MAX: 65.5, KRAI_LNG_MIN: 155.0, KRAI_LNG_MAX: 174.0,
}));

import { runRouteEndpoints } from '@/lib/import/route-endpoints-runner';

const ROUTE_ID = '11111111-1111-1111-1111-111111111111';

function mockRoute(markdown: string | null) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM kamchatka_routes r') && sql.includes('LEFT JOIN route_passport_ocr')) {
      // LEFT JOIN: строка маршрута приходит всегда, markdown null, если OCR нет.
      return Promise.resolve({
        rows: [{ route_id: ROUTE_ID, title: 'Тестовый маршрут', markdown, pdf_url: 'https://visitkamchatka.ru/x.pdf' }],
      });
    }
    if (sql.includes('FROM places')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT COUNT(*)::text AS n FROM route_waypoints')) return Promise.resolve({ rows: [{ n: '0' }] });
    if (sql.includes('INSERT INTO places')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO route_waypoints')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  callAIWaterfallMock.mockReset();
});

describe('runRouteEndpoints: поведение', () => {
  it('нет строки OCR — ocr_missing, AI не вызывается', async () => {
    mockRoute(null);
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: true });
    expect(r.details[0].status).toBe('ocr_missing');
    expect(callAIWaterfallMock).not.toHaveBeenCalled();
  });

  it('координата разобрана и записана: place создаётся, waypoint линкуется', async () => {
    mockRoute('паспорт с координатами');
    callAIWaterfallMock.mockResolvedValue(JSON.stringify({
      start: { name: null, coord_text: `52°50'26"N 158°09'06"E` },
      end: { name: null, coord_text: `52°50'26"N 158°09'06"E` },
    }));
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: false });
    expect(r.points_linked).toBe(2);
    expect(r.places_created).toBe(2);
    const insertPlaces = poolQueryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO places'));
    expect(insertPlaces.length).toBe(2);
  });

  it('сухой прогон ничего не пишет', async () => {
    mockRoute('паспорт с координатами');
    callAIWaterfallMock.mockResolvedValue(JSON.stringify({
      start: { name: null, coord_text: `52°50'26"N 158°09'06"E` },
      end: { name: null, coord_text: null },
    }));
    poolQueryMock.mockReset();
    mockRoute('паспорт с координатами');
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: true });
    const writes = poolQueryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO places|INSERT INTO route_waypoints/.test(String(sql)));
    expect(writes.length).toBe(0);
    // Но результат всё равно честно называет, что бы связалось.
    expect(r.details[0].start?.kind).toBe('linked');
  });

  it('именованная точка без координаты — skipped no_coord, place не создаётся', async () => {
    mockRoute('паспорт с ориентирами');
    callAIWaterfallMock.mockResolvedValue(JSON.stringify({
      start: { name: 'Кордон «Авачинский»', coord_text: null },
      end: { name: 'Кордон «Центральный»', coord_text: null },
    }));
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: false });
    expect(r.points_linked).toBe(0);
    const d = r.details[0];
    expect(d.start).toEqual({ kind: 'skipped', reason: 'no_coord', name: 'Кордон «Авачинский»', coord_text: null });
  });

  it('координата вне Камчатки отбрасывается, а не записывается', async () => {
    mockRoute('паспорт с чужой координатой');
    callAIWaterfallMock.mockResolvedValue(JSON.stringify({
      start: { name: null, coord_text: '10.000000, 20.000000' },
      end: { name: null, coord_text: null },
    }));
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: false });
    expect(r.details[0].start).toEqual({
      kind: 'skipped', reason: 'coord_out_of_range', name: null, coord_text: '10.000000, 20.000000',
    });
    expect(r.points_linked).toBe(0);
  });

  it('модель не вернула разбираемый JSON — parse_failed, ничего не пишет', async () => {
    mockRoute('паспорт');
    callAIWaterfallMock.mockResolvedValue('извините, не смог разобрать');
    const r = await runRouteEndpoints({ routeIds: [ROUTE_ID], source: 'тест', why: 'тест', dryRun: false });
    expect(r.details[0].status).toBe('parse_failed');
  });
});
