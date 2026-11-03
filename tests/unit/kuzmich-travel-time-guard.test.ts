import { describe, it, expect } from 'vitest';
import { stripUngroundedTravelTimeClaims, stripUngroundedDistanceClaims, TRAVEL_TIME_HONEST_LINE } from '@/lib/kuzmich/distance-guard';
import { travelFactsBlock, TRAVEL_FACTS } from '@/lib/kuzmich/travel-facts';

const LOG3 = 'Как туда добираются:\n- Вертолётом — основной способ, около 1–1,5 часа лёта из Елизово.\n- На внедорожнике — многодневный маршрут вдоль Охотского моря, обычно 2–3 дня пути в одну сторону (туры на 3–4 дня).\n\nОпасность места — медведи.';

describe('время в пути без данных', () => {
  it('logistics-3: часы лёта и дни пути вырезаны, остальное цело', () => {
    const r = stripUngroundedTravelTimeClaims(LOG3, 'Курильское озеро, статус красный');
    expect(r.cleaned).not.toContain('1–1,5 часа');
    expect(r.cleaned).not.toContain('2–3 дня пути');
    expect(r.cleaned).toContain(TRAVEL_TIME_HONEST_LINE);
    expect(r.cleaned.split(TRAVEL_TIME_HONEST_LINE).length).toBe(2);
    expect(r.cleaned).toContain('Опасность места — медведи.');
    expect(r.removed.length).toBe(2);
  });
  it('время из контекста остаётся', () => {
    const ctx = travelFactsBlock('Сколько ехать до Курильского озера?');
    const a = 'Перелёт вертолётом из Елизово около 1 ч 15 мин – 1 ч 20 мин.';
    expect(stripUngroundedTravelTimeClaims(a, ctx).cleaned).toBe(a);
    const m = 'До Малков на машине около 1,5–2 часов.';
    expect(stripUngroundedTravelTimeClaims(m, travelFactsBlock('Малкинские источники далеко?')).cleaned).toBe(m);
  });
  it('logistics-2: выдуманные 3–3,5 часа на машине вырезаны', () => {
    const r = stripUngroundedTravelTimeClaims('До Малкинских источников 3–3,5 часа на машине.', 'Малки 120 км');
    expect(r.removed).toHaveLength(1);
  });
  it('длительность тура, строки каталога и время на маршруте не трогаются', () => {
    const tours = '- «Толбачик: по следам извержений, 4 дня» — Андрей Запорожец, от 85 000 ₽/чел.';
    expect(stripUngroundedTravelTimeClaims(tours, '').cleaned).toBe(tours);
    const tour = 'Тур на 4 дня с проживанием на кордоне.';
    expect(stripUngroundedTravelTimeClaims(tour, '').cleaned).toBe(tour);
    const hike = 'Подъём занимает около 12,5 часов.';
    expect(stripUngroundedTravelTimeClaims(hike, '').cleaned).toBe(hike);
  });
  it('входит в общий distance-guard', () => {
    expect(stripUngroundedDistanceClaims(LOG3, '').removed.length).toBe(2);
  });
});

describe('travel-facts: только с источником', () => {
  it('у каждого факта есть https-источник и хотя бы одно поле', () => {
    for (const f of TRAVEL_FACTS) {
      expect(f.sources.length).toBeGreaterThan(0);
      for (const s of f.sources) expect(s).toMatch(/^https?:\/\//);
      expect(Boolean(f.distance || f.time)).toBe(true);
    }
  });
  it('Малки — 130 км по трассе, не 200', () => {
    const b = travelFactsBlock('Как далеко Малкинские источники от города?');
    expect(b).toContain('130 км');
    expect(b).not.toContain('200 км');
  });
  it('нет времени — сказано, что подтвердит оператор', () => {
    expect(travelFactsBlock('Паратунка')).toContain('подтвердит оператор/перевозчик');
    expect(travelFactsBlock('что посмотреть в городе')).toBe('');
  });
});

describe('пеший маршрут — не время дороги', () => {
  it('«подъём около 6 часов, 12 км в одну сторону» цел', () => {
    const a = 'Маршрут к вулкану Горелый: подъём около 6 часов, 12 км в одну сторону.';
    expect(stripUngroundedTravelTimeClaims(a, '').cleaned).toBe(a);
  });
});
