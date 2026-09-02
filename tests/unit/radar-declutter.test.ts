/**
 * Близкие точки радара расходятся, чтобы каждая была видна и тапаема.
 *
 * ── Случай 02.09 ───────────────────────────────────────────────────────────
 *
 * Владелец, глядя на /safety: «Ключевского не вижу на карте, а он постоянно
 * извергается». Ключевской в данных БЫЛ — оранжевый, координаты внутри
 * 500-км круга (живая проба place-audit + разбор RSC-полезной нагрузки
 * /safety это подтвердили). Причина оказалась в отрисовке: на масштабе
 * радара Ключевская сопка и Безымянный стоят в 1.8 условной единицы друг от
 * друга при радиусе самой точки 4 — верхняя (критичная, рисуется поверх)
 * полностью закрывала нижнюю. Рядом же, в 14-16 единицах, Шивелуч с
 * пульсирующим кольцом критичной точки (до ~11 единиц радиуса) — три
 * вулкана сливались в один блик.
 *
 * Числа ниже — реальные координаты этих трёх вулканов и Петропавловска
 * (центр радара по умолчанию), не выдуманный пример.
 */
import { describe, it, expect } from 'vitest';
import { declutterPlaced, RADAR_MIN_SEP } from '@/components/safety/LiveStatus';

const R = 92, CX = 100, CY = 100, MAX_KM = 500;
const KM_LAT = 111.32;
const PPK = { lat: 53.0444, lng: 158.6483 };

function project(lat: number, lng: number, label: string, level: string) {
  const kmLng = KM_LAT * Math.cos((PPK.lat * Math.PI) / 180);
  const north = (lat - PPK.lat) * KM_LAT;
  const east = (lng - PPK.lng) * kmLng;
  const dist = Math.hypot(north, east);
  return {
    label, level, kind: 'volcano', lat, lng, note: '',
    dist, x: CX + (east / MAX_KM) * R, y: CY - (north / MAX_KM) * R,
  };
}

const KLYUCHEVSKAYA = project(56.05641830, 160.64229890, 'Вулкан Ключевская сопка', 'critical');
const BEZYMIANNY = project(55.97263290, 160.59528310, 'Безымянный', 'danger');
const SHEVELUCH = project(56.63661270, 161.31220660, 'Шивелуч', 'critical');
const KRASHENINNIKOV = project(54.59686700, 160.27625000, 'Вулкан Крашенинникова', 'danger');

describe('живой случай: Ключевская сопка была невидима за Безымянным', () => {
  it('до раскладки точки почти совпадают — это и есть дефект', () => {
    const raw = Math.hypot(KLYUCHEVSKAYA.x - BEZYMIANNY.x, KLYUCHEVSKAYA.y - BEZYMIANNY.y);
    expect(raw).toBeLessThan(RADAR_MIN_SEP);
    expect(raw).toBeCloseTo(1.8, 0);
  });

  it('после раскладки обе видны порознь', () => {
    const out = declutterPlaced([KLYUCHEVSKAYA, BEZYMIANNY, SHEVELUCH]);
    const kl = out.find((p) => p.label === KLYUCHEVSKAYA.label)!;
    const bz = out.find((p) => p.label === BEZYMIANNY.label)!;
    expect(Math.hypot(kl.x - bz.x, kl.y - bz.y)).toBeGreaterThanOrEqual(RADAR_MIN_SEP - 0.01);
  });

  it('Шивелуч, стоявший рядом, тоже остаётся своей отдельной точкой', () => {
    const out = declutterPlaced([KLYUCHEVSKAYA, BEZYMIANNY, SHEVELUCH]);
    expect(out.find((p) => p.label === SHEVELUCH.label)).toBeDefined();
    expect(out).toHaveLength(3);
  });

  it('реальная позиция (dist, lat, lng) для карточки при тапе не меняется', () => {
    const out = declutterPlaced([KLYUCHEVSKAYA, BEZYMIANNY, SHEVELUCH]);
    const kl = out.find((p) => p.label === KLYUCHEVSKAYA.label)!;
    expect(kl.dist).toBe(KLYUCHEVSKAYA.dist);
    expect(kl.lat).toBe(KLYUCHEVSKAYA.lat);
    expect(kl.lng).toBe(KLYUCHEVSKAYA.lng);
  });
});

describe('раскладка не портит то, что уже не сломано', () => {
  it('одиночная точка не двигается', () => {
    const out = declutterPlaced([KRASHENINNIKOV]);
    expect(out[0].x).toBe(KRASHENINNIKOV.x);
    expect(out[0].y).toBe(KRASHENINNIKOV.y);
  });

  it('далёкая точка (Крашенинников) не трогается раскладкой соседей', () => {
    const out = declutterPlaced([KLYUCHEVSKAYA, BEZYMIANNY, SHEVELUCH, KRASHENINNIKOV]);
    const kr = out.find((p) => p.label === KRASHENINNIKOV.label)!;
    expect(kr.x).toBe(KRASHENINNIKOV.x);
    expect(kr.y).toBe(KRASHENINNIKOV.y);
  });

  it('пустой список не падает', () => {
    expect(declutterPlaced([])).toEqual([]);
  });

  it('порядок раскладки — по имени, детерминированно: разный порядок входа даёт тот же результат', () => {
    const a = declutterPlaced([KLYUCHEVSKAYA, BEZYMIANNY]);
    const b = declutterPlaced([BEZYMIANNY, KLYUCHEVSKAYA]);
    const ka = a.find((p) => p.label === KLYUCHEVSKAYA.label)!;
    const kb = b.find((p) => p.label === KLYUCHEVSKAYA.label)!;
    expect(ka.x).toBeCloseTo(kb.x, 6);
    expect(ka.y).toBeCloseTo(kb.y, 6);
  });
});

describe('компонент вызывает раскладку', () => {
  it('RadarScope раскладывает точки до сортировки по слою и до подсчёта', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8',
    );
    expect(src).toMatch(/const placed: Placed\[\] = declutterPlaced\(placedRaw\)/);
  });
});
