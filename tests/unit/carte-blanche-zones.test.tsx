/**
 * Решения по районам и тревогам, принятые по карт-бланшу владельца 16.10
 * («Я тебе даю все права карт-бланш», #2522).
 *
 *   1. Восток Елизовского района — оставить: сводка «по Елизовскому» только
 *      Авачинской зоне (#2293), объекты востока названы картой вулканов.
 *   2. Северные Курилы — метка вне края: камчатская погода нет, цунами да,
 *      Эбеко и Алаид — их метка; карточка не пишет «предупреждений нет».
 *   3. Жупановский — тревога о нём в обе зоны: и Налычево, и восток.
 *   4. Корякский округ — метка округа вместо «северной» (1299).
 *   5. Пещеры — горные места: морская тревога их не касается.
 *   6. Рубрики — не маршруты: 23 записи без точки спрятаны (1300).
 *
 * Судится вызовом настоящего разбора приёма, рендером полосы «Сейчас» и
 * совета Кузьмича и текстом миграций по смыслу.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PlaceRealtimeStatus from '@/components/places/PlaceRealtimeStatus';
import type { PlaceRealtime } from '@/components/places/types';
import { placeDayStatus } from '@/lib/safety/place-day-status';
import { buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';
import { classifyMessage, mchs_zones, tsunamiAlertZones, TSUNAMI_WIDE_ZONES } from '@/lib/services/safety/seismic-parser';
import { KURIL_NORTH_BOX, KURIL_NORTH_NOTE, KURIL_NORTH_ZONE, isOutsideKraiSources } from '@/lib/safety/kuril-north';
import { KRAI_KORYAK_ZONE } from '@/lib/safety/krai-far';
import { KRAI_WIDE_ZONES } from '@/lib/safety/alert-zones';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { zoneName } from '@/lib/safety/zone-names';
import { MOUNTAIN_PLACE_TYPES } from '@/lib/safety/marine-alert';
import { migrationBody } from '../helpers/migration-sql';

afterEach(cleanup);

const NOW = Date.parse('2026-10-16T06:00:00.000Z');
const FRESH = new Date(NOW - 10 * 60 * 1000).toISOString();
const rt = (over: Partial<PlaceRealtime> = {}): PlaceRealtime => ({
  isOpen: true, currentCrowds: null, currentWeather: null, activeAlerts: [], alertSeverity: 0,
  alertMessage: null, touristsToday: null, touristsHour: null,
  status: 'green', linkedVolcanoes: null, updatedAt: FRESH,
  ...over,
});

describe('1. восток Елизовского района — оставлен (#2293)', () => {
  it('сводка «по Елизовскому» — только Авачинская зона; восток называется объектами', () => {
    expect(mchs_zones('Подъём воды на реках Елизовского района')).toEqual(['avachinsky']);
    expect(mchs_zones('Ограничение посещения Узона')).toEqual(['eastern']);
    expect(mchs_zones('Выбросы пепла вулкана Карымский')).toEqual(['eastern']);
  });
});

describe('2. Северные Курилы — Сахалинская область', () => {
  it('Эбеко и Алаид — метка Курил, а не «северная» зона края', () => {
    expect(mchs_zones('Пепловые выбросы вулкана Эбеко до 3 км')).toEqual([KURIL_NORTH_ZONE]);
    expect(mchs_zones('Извержение вулкана Алаид')).toEqual([KURIL_NORTH_ZONE]);
    expect(mchs_zones('Шторм у Северо-Курильска')).toEqual([KURIL_NORTH_ZONE]);
  });

  it('камчатская погода «по всему краю» до них не доходит, цунами — доходит', () => {
    expect(mchs_zones('Штормовое предупреждение по всему краю')).not.toContain(KURIL_NORTH_ZONE);
    expect(KRAI_WIDE_ZONES).not.toContain(KURIL_NORTH_ZONE);
    expect(TSUNAMI_WIDE_ZONES).toContain(KURIL_NORTH_ZONE);
    expect(tsunamiAlertZones([])).toContain(KURIL_NORTH_ZONE);
    // Названный округ — по округу: Курилы туда не добавляются.
    expect(tsunamiAlertZones(['avachinsky'])).toEqual(['avachinsky']);
    const kbgs = classifyMessage('t.me/kbgsras/t', 'Объявлена угроза цунами для восточного побережья Камчатки.', new Date(NOW).toISOString());
    expect(kbgs?.affected_zones).toContain(KURIL_NORTH_ZONE);
  });

  it('прямоугольник — Парамушир и Шумшу внутри, мыс Лопатка снаружи', () => {
    const inBox = (lat: number, lng: number) =>
      lat >= KURIL_NORTH_BOX.minLat && lat <= KURIL_NORTH_BOX.maxLat && lng >= KURIL_NORTH_BOX.minLng && lng <= KURIL_NORTH_BOX.maxLng;
    expect(inBox(50.678, 156.125)).toBe(true);   // Северо-Курильск
    expect(inBox(50.840, 156.428)).toBe(true);   // Шумшу, танк
    expect(inBox(50.858, 155.557)).toBe(true);   // Алаид
    expect(inBox(50.877, 156.681)).toBe(false);  // мыс Лопатка
    expect(inBox(51.507, 157.693)).toBe(false);  // остров Уташуд
  });

  it('подпись района — словами, с областью', () => {
    expect(placeZoneLabel(KURIL_NORTH_ZONE)).toBe('Северные Курилы (Сахалинская обл.)');
    expect(zoneName(KURIL_NORTH_ZONE)).toBe('Северные Курилы (Сахалинская область)');
    expect(isOutsideKraiSources('kuril_north')).toBe(true);
    expect(isOutsideKraiSources('western')).toBe(false);
    expect(isOutsideKraiSources(null)).toBe(false);
  });

  it('зелёный на Курилах — «не знаем», жёлтый и красный — как есть', () => {
    expect(placeDayStatus(rt({ outsideKraiSources: true }), NOW)).toEqual({ level: 'unknown', stale: false, outsideSources: true });
    expect(placeDayStatus(rt({ outsideKraiSources: true, status: 'yellow' }), NOW).level).toBe('yellow');
    expect(placeDayStatus(rt({ outsideKraiSources: true, status: 'red' }), NOW).level).toBe('red');
    expect(placeDayStatus(rt({ outsideKraiSources: true, isOpen: false }), NOW).level).toBe('closed');
    expect(placeDayStatus(rt(), NOW).level).toBe('green');
  });

  it('полоса «Сейчас» не пишет «предупреждений нет» и называет, почему не знаем', () => {
    render(<PlaceRealtimeStatus realtime={rt({ outsideKraiSources: true })} now={NOW} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('Обстановку сейчас не знаем');
    expect(text).toContain('Сахалинская область');
    expect(text).not.toContain('Предупреждений по месту нет');
    expect(text).not.toContain('Пересчёта обстановки по этому месту у нас нет');
  });

  it('совет Кузьмича на карточке говорит то же', () => {
    const a = buildPlaceAdvisory({
      volcano: null,
      realtime: { ...placeDayStatus(rt({ outsideKraiSources: true }), NOW), activeAlerts: [] },
      hazardTypes: [],
    }, NOW);
    expect(a.tone).toBe('unknown');
    expect(a.lines).toContain(KURIL_NORTH_NOTE);
  });
});

describe('3. Жупановский — тревога в обе зоны', () => {
  it('и Налычево (Авачинская), и восток', () => {
    expect(new Set(mchs_zones('Пепловый выброс вулкана Жупановский'))).toEqual(new Set(['eastern', 'avachinsky']));
  });
});

describe('4. Корякский округ — метка округа', () => {
  it('подпись района и разбор приёма', () => {
    expect(placeZoneLabel(KRAI_KORYAK_ZONE)).toBe('Корякский округ');
    expect(mchs_zones('Подъём воды на реках Тигильского района')).toEqual([KRAI_KORYAK_ZONE]);
    // Сводка об Усть-Камчатском — «северная», и до корякской метки не доходит.
    expect(mchs_zones('Паводок в Усть-Камчатском районе')).toEqual(['northern']);
  });
});

describe('5. пещеры — горные места', () => {
  it('морская тревога их не касается', () => {
    expect(MOUNTAIN_PLACE_TYPES).toContain('cave');
  });
});

const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8');

describe('миграции 1299 и 1300', () => {
  const SQL_1299 = read('1299_place_zone_koryak_kuril_north.sql');
  const SQL_1300 = read('1300_rubric_routes_hidden.sql');
  const pairs = (sql: string) =>
    [...sql.matchAll(/\('([0-9a-f-]{36})', (NULL|'([a-z_]+)'), '([a-z_]+)'\)/g)].map((m) => ({ id: m[1], from: m[3] ?? null, to: m[4] }));

  it('1299: 26 корякских мест и 12 курильских, три корякских маршрута; «Командоры» не тронуты', () => {
    const rows = pairs(SQL_1299);
    expect(rows).toHaveLength(41);
    expect(rows.filter((r) => r.to === KRAI_KORYAK_ZONE)).toHaveLength(29);
    expect(rows.filter((r) => r.to === KURIL_NORTH_ZONE)).toHaveLength(12);
    expect(new Set(rows.map((r) => r.id)).size).toBe(41);
    for (const r of rows) expect(r.from, r.id).not.toBe('commander');
    // Курилы — только из камчатских зон, которые им не принадлежали.
    for (const r of rows.filter((x) => x.to === KURIL_NORTH_ZONE)) expect(['western', 'avachinsky']).toContain(r.from);
    // Корякские — из «северной» или пустоты (заповедник).
    for (const r of rows.filter((x) => x.to === KRAI_KORYAK_ZONE)) expect([null, 'northern']).toContain(r.from);
    expect(SQL_1299.match(/IS NOT DISTINCT FROM v\.zone_from;/g)).toHaveLength(2);
  });

  it('1300: 23 рубрики прячутся, не удаляются; тур держит запись; точка у маршрута — держит', () => {
    const body = migrationBody(SQL_1300);
    const ids = [...body.matchAll(/\('([0-9a-f-]{36})'\)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(23);
    expect(body).toMatch(/SET is_visible = false/);
    expect(body).not.toMatch(/\bDELETE\b/i);
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM operator_tours ot WHERE ot\.route_id::text = r\.id::text\)/);
    expect(body).toMatch(/AND \(r\.lat IS NULL OR r\.lng IS NULL\)/);
  });
});
