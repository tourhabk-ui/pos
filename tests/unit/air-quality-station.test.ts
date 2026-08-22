/**
 * Сторож: цифра качества воздуха называет, откуда она.
 *
 * 23.08.2026, замер с прода: из шести вулканических зон IQAir отвечает по
 * ДВУМ — Мутновский и Авачинский, обе рядом с Петропавловском. Толбачик,
 * Ключевская группа, Налычево и Южная Камчатка — ни одной записи
 * (`ageMinutes: null`, то есть данных не было вовсе). А заводился сигнал
 * ровно ради пепловых выбросов Ключевской группы и Толбачика.
 *
 * До этого дня модуль брал из ответа `aqius` и `mainus`, а город станции и её
 * координаты выбрасывал. Получалось «Толбачик: AQI 42» без всякой
 * возможности узнать, что мерили в городе за сотни километров. Показывать
 * такое туристу — выдавать воздух Петропавловска за воздух вулкана.
 *
 * Здесь закреплено: станция называется, расстояние считается, а когда
 * назвать нечего — так и говорится, без подстановки нуля.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  stationProximity, STATION_NEAR_KM, STATION_REGION_KM,
  type StationProximity,
} from '@/lib/services/safety/air-quality';

const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/air-quality.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('stationProximity: что цифра описывает', () => {
  it('станция в зоне — это воздух зоны', () => {
    expect(stationProximity(0)).toBe<StationProximity>('zone');
    expect(stationProximity(STATION_NEAR_KM)).toBe<StationProximity>('zone');
  });

  it('окрестность — уже не зона', () => {
    expect(stationProximity(STATION_NEAR_KM + 1)).toBe<StationProximity>('nearby');
    expect(stationProximity(STATION_REGION_KM)).toBe<StationProximity>('nearby');
  });

  it('дальняя станция названа дальней', () => {
    // 68 км от Мутновского до Петропавловска — это «рядом», а вот 400 км до
    // Толбачика уже ничего про Толбачик не говорят.
    expect(stationProximity(STATION_REGION_KM + 1)).toBe<StationProximity>('distant');
    expect(stationProximity(400)).toBe<StationProximity>('distant');
  });

  it('неизвестное расстояние НЕ выдаётся за близкое', () => {
    // §4.0: третий исход не равен первому. Иначе станция без координат
    // молча превращается в «воздух этой зоны».
    expect(stationProximity(null)).toBe<StationProximity>('unknown');
  });

  it('пороги упорядочены — иначе разбор бессмысленен', () => {
    expect(STATION_NEAR_KM).toBeLessThan(STATION_REGION_KM);
  });
});

describe('чтение станции из ответа IQAir', () => {
  it('город и регион больше не выбрасываются', () => {
    expect(SRC, 'вернулось чтение только pollution — станция снова потеряна')
      .toMatch(/data\?\.city/);
    expect(SRC).toMatch(/location\?\.coordinates/);
  });

  it('координаты читаются как GeoJSON: [долгота, широта]', () => {
    // Перепутать порядок здесь — получить станцию в океане и «расстояние» в
    // тысячи километров, которое выглядит как настоящее измерение.
    expect(SRC).toMatch(/haversineKm\(zoneLat, zoneLon, coords\[1\], coords\[0\]\)/);
  });

  it('нет координат — расстояние null, а не ноль', () => {
    expect(SRC, 'ноль читался бы как «станция прямо здесь»').not.toMatch(/distanceKm:\s*0\b/);
    expect(SRC).toMatch(/:\s*null;/);
  });

  it('станция читается по координатам ЗОНЫ и попадает в результат', () => {
    expect(SRC).toMatch(/readStation\(data, zone\.lat, zone\.lon\)/);
    expect(SRC, 'станция обязана уехать и в ответ зоны, и в стор свежести')
      // Не `[^)]*`: внутри вызова есть Date.now(), и скобка обрывает разбор.
      .toMatch(/lastSuccess\.set\([\s\S]{0,120}station/);
  });
});
