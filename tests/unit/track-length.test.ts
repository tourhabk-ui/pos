/**
 * Дооформление маршрутов с треком: дистанция считается из линии, место
 * привязывается только если линия действительно идёт рядом с ним.
 *
 * Урок, который стережёт этот файл: у записи «Озеро Икар» трек лежит в
 * 337 км от самого озера. Длина такого трека может быть правдоподобной,
 * а связь с местом — ложью, поэтому два решения принимаются раздельно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  trackLengthKm, nearestVertexKm, enrichVerdict, type Coord,
} from '@/lib/routes/track-length';

const ROOT = process.cwd();

// Петропавловск → Елизово, [lng, lat]
const pk: Coord = [158.643, 53.024];
const elizovo: Coord = [158.388, 53.183];

describe('длина трека', () => {
  it('ПК — Елизово по прямой около 27 км', () => {
    const km = trackLengthKm([pk, elizovo]);
    expect(km).toBeGreaterThan(20);
    expect(km).toBeLessThan(30);
  });

  it('ломаная суммируется по звеньям', () => {
    const straight = trackLengthKm([pk, elizovo]);
    const viaMiddle = trackLengthKm([pk, [158.5, 53.1], elizovo]);
    expect(viaMiddle).toBeGreaterThanOrEqual(straight);
  });

  it('одна вершина — нулевая длина, не ошибка', () => {
    expect(trackLengthKm([pk])).toBe(0);
    expect(trackLengthKm([])).toBe(0);
  });
});

describe('близость трека к месту', () => {
  it('место на трассе — расстояние около нуля', () => {
    expect(nearestVertexKm([pk, elizovo], 53.024, 158.643)).toBeLessThan(0.2);
  });

  it('место в стороне — расстояние настоящее', () => {
    const d = nearestVertexKm([pk, elizovo], 56.05, 160.64);
    expect(d).toBeGreaterThan(200);
  });
});

describe('вердикт дооформления', () => {
  const good = { lengthKm: 12.5, placeOffsetKm: 0.4, vertexCount: 210 };

  it('нормальная тропа рядом с местом — можно и дистанцию, и связь', () => {
    const v = enrichVerdict(good);
    expect(v.writeDistance).toBe(true);
    expect(v.linkPlace).toBe(true);
    expect(v.notes).toHaveLength(0);
  });

  it('трек далеко от места — дистанция да, связь нет', () => {
    const v = enrichVerdict({ ...good, placeOffsetKm: 337 });
    expect(v.writeDistance).toBe(true);
    expect(v.linkPlace).toBe(false);
    expect(v.notes.some(n => n.includes('не про него'))).toBe(true);
  });

  it('обрывок в сто метров — ничего не делаем', () => {
    const v = enrichVerdict({ ...good, lengthKm: 0.1 });
    expect(v.writeDistance).toBe(false);
    expect(v.linkPlace).toBe(false);
  });

  it('трёхсоткилометровая склейка — ничего не делаем', () => {
    const v = enrichVerdict({ ...good, lengthKm: 397 });
    expect(v.writeDistance).toBe(false);
    expect(v.linkPlace).toBe(false);
  });

  it('четыре вершины — не трек', () => {
    const v = enrichVerdict({ ...good, vertexCount: 4 });
    expect(v.writeDistance).toBe(false);
  });

  it('место без координат — связь не ставим, дистанцию считаем', () => {
    const v = enrichVerdict({ ...good, placeOffsetKm: null });
    expect(v.writeDistance).toBe(true);
    expect(v.linkPlace).toBe(false);
  });
});

describe('обещания эндпоинта', () => {
  const src = readFileSync(join(ROOT, 'app/api/cron/route-twins-enrich/route.ts'), 'utf-8');

  it('пишет только в пустоту — заполненное не переписывает', () => {
    expect(src).toContain('distance_km IS NULL');
    expect(src).toContain('ON CONFLICT (route_id, place_id) DO NOTHING');
  });

  it('трогает только живые записи по обе стороны', () => {
    expect(src).toContain('r.is_visible = true');
    expect(src).toContain('r.merged_into_id IS NULL');
    expect(src).toContain('p.merged_into_id IS NULL');
  });

  it('сухой прогон — поведение по умолчанию', () => {
    expect(src).toMatch(/dry_run: z\.boolean\(\)\.default\(true\)/);
  });

  it('боевой прогон ограничен десятью записями за раз', () => {
    expect(src).toContain('LIVE_BATCH_MAX = 10');
    expect(src, 'ограничение обязано быть проверкой, а не только значением по умолчанию')
      .toMatch(/!data\.dry_run && liveSize > LIVE_BATCH_MAX/);
  });
});
