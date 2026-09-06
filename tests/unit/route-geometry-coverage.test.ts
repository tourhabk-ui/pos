/**
 * Покрытие маршрутов треком для офлайн-карты (#1643).
 *
 * Маршрут без линии офлайн-карта не проведёт: на экране только имя, и
 * человек в поле остаётся с бумажкой. Доля таких маршрутов — прибор главной,
 * а не подразумеваемое «всё есть». У прибора три состояния, и третье —
 * «не посчитано» — обязано выглядеть иначе, чем «хорошо»: упавший запрос или
 * пустой каталог не имеют права на зелёную точку (§4.0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  geometryCoverage,
  coverageDot,
  GEOMETRY_GAP_WARN_PCT,
} from '@/lib/home/data-freshness';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { countRoutesWithoutGeometry } from '@/lib/services/routes/routes-geometry-health';

describe('geometryCoverage — три состояния', () => {
  it('ниже порога — «хорошо», зелёная точка и доля с треком', () => {
    const c = geometryCoverage({ total: 100, withoutTrack: 10 });
    expect(c.state).toBe('ok');
    expect(c.pct).toBe(90);
    expect(c.label).toBe('Линия для офлайн-карты есть у 90% маршрутов');
    expect(coverageDot(c.state)).toBe('var(--success)');
  });

  it('больше порога без трека — предупреждение словами и числом', () => {
    const c = geometryCoverage({ total: 392, withoutTrack: 106 });
    expect(c.state).toBe('warning');
    expect(c.pct).toBe(73);
    expect(c.label).toBe('Без линии для офлайн-карты 106 маршрутов из 392');
    expect(coverageDot(c.state)).toBe('var(--warning)');
  });

  it('порог — ровно 20%: на нём ещё «хорошо», за ним — тревога', () => {
    expect(GEOMETRY_GAP_WARN_PCT).toBe(20);
    expect(geometryCoverage({ total: 100, withoutTrack: 20 }).state).toBe('ok');
    expect(geometryCoverage({ total: 100, withoutTrack: 21 }).state).toBe('warning');
  });

  it('склонение по числу: 1 маршрут, 2 маршрута, 5 маршрутов', () => {
    expect(geometryCoverage({ total: 3, withoutTrack: 1 }).label).toContain('1 маршрут из 3');
    expect(geometryCoverage({ total: 5, withoutTrack: 2 }).label).toContain('2 маршрута из 5');
    expect(geometryCoverage({ total: 9, withoutTrack: 5 }).label).toContain('5 маршрутов из 9');
  });

  it.each([
    ['запрос упал', { total: null, withoutTrack: null }],
    ['часть неизвестна', { total: 10, withoutTrack: null }],
    ['пустой каталог', { total: 0, withoutTrack: 0 }],
    ['часть больше целого', { total: 5, withoutTrack: 7 }],
    ['не целое', { total: 10.5, withoutTrack: 1 }],
    ['отрицательное', { total: 10, withoutTrack: -1 }],
  ])('%s → «не посчитано», без доли и БЕЗ точки', (_name, input) => {
    const c = geometryCoverage(input);
    expect(c.state).toBe('unknown');
    expect(c.pct).toBeNull();
    expect(c.label).toBe('Линии маршрутов для офлайн-карты не посчитаны');
    // Главное: никакой зелёной точки. Зелёное = «проверено и хорошо».
    expect(coverageDot(c.state)).toBeNull();
  });
});

describe('подпись обещает ровно то, что посчитано', () => {
  /**
   * Первая редакция считала «geometry не NULL и точек больше одной», а
   * подписывала «Трек для офлайн-карты есть у N%». В §12 трек — род линии,
   * который ОДИН даёт право обещать ведение; набросок прямыми и линия из
   * скрейпа понижены решением владельца 17.08 и ведения не обещают. Замер
   * 04.09: из 392 живых скрейп 252, синтетика 10 — то есть почти всё, что
   * счётчик засчитал бы в «трек». Подпись обещала бы ведение там, где
   * платформа его сознательно не даёт, и цифра встала бы в один ряд с
   * «778 местами» и «20 турами».
   *
   * Право вести решает lib/routes/navigability и одним запросом не считается.
   * Поэтому подпись говорит про НАЛИЧИЕ ЛИНИИ — и не смеет говорить иначе.
   */
  const labels = [
    geometryCoverage({ total: 100, withoutTrack: 10 }).label,
    geometryCoverage({ total: 100, withoutTrack: 50 }).label,
    geometryCoverage({ total: null, withoutTrack: null }).label,
  ];

  it('ни одна подпись не называет линию треком', () => {
    for (const l of labels) expect(l.toLowerCase()).not.toMatch(/трек/);
  });

  it('ни одна подпись не обещает ведения по линии', () => {
    for (const l of labels) expect(l.toLowerCase()).not.toMatch(/вед[её]т|проведёт|навигац/);
  });

  it('счётчик не выдаёт себя за меру навигабельности', () => {
    const HEALTH = readFileSync(join(process.cwd(), 'lib/services/routes/routes-geometry-health.ts'), 'utf-8');
    // Правило про право вести живёт в одном месте; если счётчик когда-нибудь
    // начнёт его считать — он обязан звать его, а не заводить своё.
    expect(HEALTH).toMatch(/navigability/);
  });
});

describe('countRoutesWithoutGeometry — счётчик для главной', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockQuery.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it('отдаёт три числа: всего, без трека, geometry IS NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '392', without_track: '116', geometry_null: '106' }] });
    await expect(countRoutesWithoutGeometry()).resolves.toEqual({
      total: 392, without_track: 116, geometry_null: 106,
    });
  });

  it('одним запросом, только живые маршруты, считает NULL-геометрию отдельно', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1', without_track: '0', geometry_null: '0' }] });
    await countRoutesWithoutGeometry();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/FROM\s+kamchatka_routes\b/);
    expect(sql).toMatch(/is_visible\s*=\s*TRUE\s+AND\s+merged_into_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/FILTER \(WHERE geometry IS NULL\)/);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  it('упавший запрос — null и строка в лог с SQLSTATE, не ноль', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { code: '42P01' }));
    await expect(countRoutesWithoutGeometry()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('42P01');
  });

  it('пустой или нечисловой ответ — тоже null, не выдуманный ноль', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(countRoutesWithoutGeometry()).resolves.toBeNull();
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 'много', without_track: '1', geometry_null: '1' }] });
    await expect(countRoutesWithoutGeometry()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe('главная показывает покрытие и не теряет третье состояние', () => {
  const HOME = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
  const DATA = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
  const HEALTH = readFileSync(join(process.cwd(), 'lib/services/routes/routes-geometry-health.ts'), 'utf-8');

  it('data-слой зовёт счётчик и допускает null в типе', () => {
    expect(DATA).toContain('countRoutesWithoutGeometry()');
    expect(DATA).toMatch(/geometry:\s*RouteGeometryGap \| null/);
  });

  it('живой блок рисует строку покрытия через geometryCoverage и coverageDot', () => {
    const live = HOME.slice(HOME.indexOf('<section className="live">'), HOME.indexOf('</section>', HOME.indexOf('<section className="live">')));
    expect(live).toContain('{coverage.label}');
    expect(live).toContain('coverageDot(coverage.state)');
    // «Не посчитано» — без цветной точки, только контур, как у свежести.
    expect(live).toMatch(/lv-cov[\s\S]*border: '1px solid var\(--text-muted\)'/);
    expect(HOME).toContain("geometryCoverage({");
  });

  it('предупреждение подсвечено токеном, не hex', () => {
    expect(HOME).toMatch(/\.lv-warn \.lv-txt\{color:var\(--warning\)/);
  });

  it('порог «ok» на /hub/admin/health — то же число, что и порог тревоги главной', () => {
    expect(HEALTH).toContain('OK_THRESHOLD_PCT = 100 - GEOMETRY_GAP_WARN_PCT');
  });
});
