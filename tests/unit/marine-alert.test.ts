/**
 * Морская тревога не висит на горных местах (решение владельца 09.10, #2293).
 *
 * «Опасное волнение моря» МЧС и «прибрежные события» Росгидромета доходили
 * зоной до Ключевской и Шивелуча — вулканов в сотне километров от берега.
 * Исполнение на настоящем PostgreSQL — tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isMarineAlert, LAND_TITLE, MARINE_ALERT_SQL, MARINE_TITLE, MOUNTAIN_PLACE_SQL, MOUNTAIN_PLACE_TYPES,
} from '@/lib/safety/marine-alert';
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';
import { LOCATION_TYPES } from '@/lib/places/location-types';

describe('что считается морской тревогой', () => {
  it('заголовки с прода 08–09.10 — морские', () => {
    expect(isMarineAlert('weather', 'Экстренное предупреждение на 8-9 октября 2026 г. (опасное волнение моря)')).toBe(true);
    expect(isMarineAlert('weather', 'Росгидромет: прибрежные события — жёлтый уровень (юг края)')).toBe(true);
  });

  it('морское вместе с сухопутным — не морская: ветер вулкана касается', () => {
    expect(isMarineAlert('weather', 'Экстренное предупреждение (сильный ветер, опасное волнение моря)')).toBe(false);
    expect(isMarineAlert('weather', 'Волнение моря и сильный снег')).toBe(false);
  });

  it('«жёлтый уровень» Росгидромета не делает тревогу сухопутной', () => {
    expect(LAND_TITLE.test('росгидромет: прибрежные события — оранжевый уровень (север и юг края)')).toBe(false);
  });

  it('только погодная: цунами и паводок правило не трогает', () => {
    expect(isMarineAlert('tsunami_warning', 'Опасное волнение моря')).toBe(false);
    expect(isMarineAlert('flood', 'Опасное волнение моря')).toBe(false);
    expect(isMarineAlert(null, 'Опасное волнение моря')).toBe(false);
  });

  it('сухопутная погода — не морская', () => {
    expect(isMarineAlert('weather', 'Экстренное предупреждение на 3 октября 2026 г. (сильный дождь)')).toBe(false);
    expect(isMarineAlert('weather', null)).toBe(false);
  });
});

describe('горные места — слово владельца 09.10', () => {
  it('вулканы, горы, перевалы, ледники, плато, гейзеры и термальные поля', () => {
    expect([...MOUNTAIN_PLACE_TYPES].sort()).toEqual(['geyser', 'glacier', 'mountain', 'pass', 'plateau', 'thermal', 'volcano']);
  });

  it('каждый тип есть в справочнике типов мест — опечатка не выключит правило молча', () => {
    for (const t of MOUNTAIN_PLACE_TYPES) expect(LOCATION_TYPES[t], t).toBeDefined();
  });

  it('бухта, пляж, мыс, остров, село и источник горными не считаются', () => {
    for (const t of ['bay', 'beach', 'cape', 'island', 'settlement', 'hot_spring']) {
      expect((MOUNTAIN_PLACE_TYPES as readonly string[]).includes(t), t).toBe(false);
    }
  });
});

describe('SQL держит то же правило', () => {
  it('шаблоны в SQL — те же, что в isMarineAlert', () => {
    expect(MARINE_ALERT_SQL).toContain(MARINE_TITLE.source);
    expect(MARINE_ALERT_SQL).toContain(LAND_TITLE.source);
    expect(MARINE_ALERT_SQL).toContain(`ea.alert_type = 'weather'`);
  });

  it('правило мест исключает пару «морская тревога × горное место»', () => {
    expect(ALERT_MATCH_SQL).toContain(`AND NOT (${MARINE_ALERT_SQL} AND ${MOUNTAIN_PLACE_SQL})`);
  });

  it('маршрутное зеркало отдаёт тип места колонкой — иначе общее правило упадёт на маршрутах', () => {
    const src = readFileSync('lib/routes/collect-signals.ts', 'utf8');
    expect(src).toMatch(/NULL::text AS location_type/);
  });
});
