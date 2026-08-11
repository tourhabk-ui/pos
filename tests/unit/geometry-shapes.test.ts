/**
 * Какие ФОРМЫ геометрии лежат в базе.
 *
 * ── Повод ──────────────────────────────────────────────────────────────────
 *
 * План «корректное чтение геометрии в /planning?mode=trail» (11.08). Две его
 * посылки проверены по коду и подтвердились:
 *
 *   1. `extractTrackpoints` читает только голый LineString — Feature,
 *      FeatureCollection и MultiLineString дают ПУСТОЙ массив;
 *   2. диапазоны координат не проверяются, только `Number.isFinite`.
 *
 * Но план предлагает начать с нормализатора обёрток, а это работа под
 * случай, которого может не быть: вся геометрия у нас либо синтетический
 * LineString из путевых точек, либо KML-импорт — тоже LineString. Поэтому
 * первым идёт СЧЁТ форм, а не разбор гипотезы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runGeometryAudit } from '@/lib/routes/geometry-audit';

/** Линия в правильном порядке осей: GeoJSON — [lng, lat]. */
const GOOD = { type: 'LineString', coordinates: [[158.6, 53.0], [158.7, 53.1]] };

function scene(rows: Array<{ id: string; title: string; geometry: unknown }>) {
  queryMock.mockImplementation((sql: string) => {
    const q = String(sql);
    if (q.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: String(rows.length) }] });
    if (q.includes('FROM route_waypoints')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows });
  });
}

beforeEach(() => queryMock.mockReset());

describe('счёт форм', () => {
  it('каждая форма названа и посчитана', async () => {
    scene([
      { id: '1', title: 'Тропа', geometry: GOOD },
      { id: '2', title: 'Обёртка', geometry: { type: 'Feature', geometry: GOOD } },
      { id: '3', title: 'Без линии', geometry: null },
    ]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.by_type['LineString']).toBe(1);
    expect(shapes.by_type['Feature']).toBe(1);
    // Отсутствие геометрии названо словами, а не слито с нулём.
    expect(shapes.by_type['(нет геометрии)']).toBe(1);
  });

  it('обёртка считается непрочитанной — сейчас она даёт пустой трек молча', async () => {
    scene([
      { id: '1', title: 'Feature', geometry: { type: 'Feature', geometry: GOOD } },
      { id: '2', title: 'Мульти', geometry: { type: 'MultiLineString', coordinates: [GOOD.coordinates] } },
      { id: '3', title: 'Тропа', geometry: GOOD },
    ]);
    expect((await runGeometryAudit()).shapes.unsupported).toBe(2);
  });
});

describe('линия есть, а вести некуда', () => {
  it('пустая и одноточечная считаются отдельно от «геометрии нет»', async () => {
    // Для API это разные факты, а сейчас оба приходят как track: null.
    scene([
      { id: '1', title: 'Пустая', geometry: { type: 'LineString', coordinates: [] } },
      { id: '2', title: 'Точка', geometry: { type: 'LineString', coordinates: [[158.6, 53]] } },
      { id: '3', title: 'Нет линии', geometry: null },
      { id: '4', title: 'Тропа', geometry: GOOD },
    ]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.empty_or_single).toBe(2);
    expect(shapes.by_type['(нет геометрии)']).toBe(1);
  });

  it('одноточечная не считается заодно и «вне диапазона»', async () => {
    // Иначе одна запись попала бы в два разреза и удвоила бы картину.
    scene([{ id: '1', title: 'Точка', geometry: { type: 'LineString', coordinates: [[158.6, 53]] } }]);
    expect((await runGeometryAudit()).shapes.out_of_range).toBe(0);
  });
});

describe('диапазоны координат', () => {
  it('годная линия нарушений не даёт', async () => {
    scene([{ id: '1', title: 'Тропа', geometry: GOOD }]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.out_of_range).toBe(0);
    expect(shapes.suspect_swapped).toBe(0);
  });

  it('перепутанный порядок осей виден и назван', async () => {
    // 53 в долготе и 158 в широте: как [lng, lat] не проходит (широта > 90),
    // как [lat, lng] проходит. Классическая перестановка.
    scene([{ id: '1', title: 'Наоборот', geometry: { type: 'LineString', coordinates: [[53.0, 158.6], [53.1, 158.7]] } }]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.out_of_range).toBe(1);
    expect(shapes.suspect_swapped).toBe(1);
    expect(shapes.samples[0].note).toContain('обратном порядке');
  });

  it('мусор в координатах — вне диапазона, но не перестановка', async () => {
    scene([{ id: '1', title: 'Мусор', geometry: { type: 'LineString', coordinates: [[999, 999], [158.6, 53]] } }]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.out_of_range).toBe(1);
    expect(shapes.suspect_swapped).toBe(0);
  });

  it('смесь мусора и перестановки однозначной НЕ считается', async () => {
    // Условие строгое: перестановкой должны объясняться ВСЕ негодные точки.
    // Иначе правило «переставить оси» починило бы половину записи и оставило
    // вторую половину лежать неверно — под видом исправленной.
    scene([{
      id: '1', title: 'Смесь',
      geometry: { type: 'LineString', coordinates: [[53.0, 158.6], [999, 999], [158.6, 53]] },
    }]);
    const { shapes } = await runGeometryAudit();
    expect(shapes.out_of_range).toBe(1);
    expect(shapes.suspect_swapped).toBe(0);
    expect(shapes.samples[0].note).toContain('разбирать человеку');
  });

  it('перепись НЕ переставляет оси', async () => {
    // Молча переставить — заменить один неизвестный факт другим. Такую
    // запись разбирает человек, а перепись только называет.
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8',
    ) as string;
    expect(src).not.toMatch(/UPDATE kamchatka_routes/);
    expect(src).not.toMatch(/coordinates\s*=\s*\[lat, lng\]/);
  });
});
