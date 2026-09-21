/**
 * Путевые точки доходят до черты — иначе она судит о пустоте.
 *
 * ── Случай 21.09 ───────────────────────────────────────────────────────────
 *
 * Запрос карточки отдаёт координаты точек как `place_lat`/`place_lng`
 * (`p.lat AS place_lat`), а фильтр перед чертой спрашивал `w.lat`/`w.lng`.
 * Такого поля в результате нет; `undefined != null` — ложь, и массив выходил
 * ПУСТЫМ всегда, с 01.09.
 *
 * Отказ выглядел как работа. Черта исправно отвечала «Линию не с чем сверить:
 * путевых точек меньше двух» — и отвечала так КАЖДОМУ маршруту, сколько бы
 * точек ему ни разметили. Рядом ломалось второе: вычисленные этапы строятся
 * при нехватке разметки, а разметки «не хватало» всегда, — то есть они
 * подменяли собой настоящие точки на всех маршрутах подряд.
 *
 * Это ровно §4.0 наоборот: не «проверка не смогла и промолчала», а проверка,
 * которая физически не могла дать положительный ответ, и потому её отрицание
 * ничего не значило. Такое не ловится глазами на ревью и не ловится тестом,
 * который проверяет текст причины: причина-то правильная.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Поведение, а не написание: точки с координатами обязаны МЕНЯТЬ вердикт.
 * Имена колонок при этом держит компилятор — строка запроса типизирована
 * (`WaypointRow`), и чужое имя больше не собирается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeCardNavigability, hasCoords, type WaypointRow } from '@/lib/routes/card-navigability';

/** Линия со снятым видом: высоты на каждой точке, шаг неровный. */
const line: number[][] = [];
for (let i = 0; i <= 40; i++) line.push([158.0 + i * 0.002, 53.0 + i * 0.002, 300 + i * 7]);
const geometry = { type: 'LineString', coordinates: line, source: 'gpx' };

/** Точка ТОЧЕЧНОГО рода: у протяжённого объекта расстояние ни о чём не говорит. */
const wp = (lat: number, lng: number): WaypointRow => ({
  place_lat: lat, place_lng: lng, location_type: 'hot_spring', link_kind: 'waypoint',
});

const verdictFor = (rows: WaypointRow[]) => routeCardNavigability({
  geometry, payload: null, waypointRows: rows, title: 'Тропа', activityType: 'hiking',
}).navigability;

describe('точки меняют вердикт, а не остаются за бортом', () => {
  it('без точек — «линию не с чем сверить» (прежний ответ ВСЕМ маршрутам)', () => {
    const v = verdictFor([]);
    expect(v.canLead).toBe(false);
    expect(v.reasons.join(' ')).toContain('меньше двух');
  });

  it('две точки на линии — ведение обещается', () => {
    // Главная проверка: до починки этот случай был недостижим в принципе.
    const v = verdictFor([wp(53.0, 158.0), wp(53.08, 158.08)]);
    expect(v.canLead, `точки не дошли до черты: ${v.reasons.join('; ')}`).toBe(true);
    expect(v.verdict).toBe('navigable');
    expect(v.reasons).toEqual([]);
  });

  it('точка в стороне — расхождение названо и указано, какая точка', () => {
    const v = verdictFor([wp(53.0, 158.0), wp(53.9, 158.9)]);
    expect(v.canLead).toBe(false);
    expect(v.reasons.join(' ')).toContain('от линии');
    expect(v.conflict?.index).toBe(1);
    expect(v.conflict?.offTrackKm).toBeGreaterThan(100);
  });
});

describe('координаты читаются под именами запроса', () => {
  it('hasCoords смотрит place_lat/place_lng', () => {
    expect(hasCoords({ place_lat: 53, place_lng: 158 })).toBe(true);
    expect(hasCoords({ place_lat: null, place_lng: 158 })).toBe(false);
    expect(hasCoords({ place_lat: 53, place_lng: undefined })).toBe(false);
  });

  it('строка без координат до черты не доходит', () => {
    const rows: WaypointRow[] = [wp(53.0, 158.0), { place_lat: null, place_lng: null }];
    expect(rows.filter(hasCoords)).toHaveLength(1);
  });
});

describe('карточка не собирает свой вердикт на месте', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/routes/[id]/route.ts'), 'utf-8');
  const code = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('зовёт общую функцию', () => {
    expect(code).toContain('routeCardNavigability({');
  });

  it('своего вызова routeNavigability в карточке не осталось', () => {
    // Читателей у вердикта двое (карточка и объяснение решения), и второй
    // обязан пересказывать ПЕРВЫЙ, а не считать свой (§12).
    expect(code).not.toMatch(/routeNavigability\(\{/);
  });

  it('фильтр координат — общий, а не выражение на месте', () => {
    expect(code).toContain('.filter(hasCoords)');
    expect(code, 'вернулось чтение несуществующей колонки').not.toMatch(/w\.lat\s*!=\s*null/);
  });
});
