/**
 * Слой хода экрана «На маршруте»: осталось · ETA · прогресс.
 *
 * Владелец 09.08 прислал разбор экрана и методику: «31.6 км до точки 1 из 2
 * без ETA и без „сколько уже прошли“» не отвечает на главный вопрос — идти ли
 * ещё пять часов или это автопереезд; «0ч 00м» выглядит как баг. Модель —
 * гибрид Нейсмита с базой 3.5 км/ч, живой темп GPS подмешивается, погода —
 * ограниченный множитель, гроза — решение safety-слоя, а не время.
 *
 * Тесты держат ровно те свойства, из-за которых экран врал: честный отказ
 * вместо нуля, потолок погоды, отказ от рельефа на авто-плече, отбрасывание
 * выбросов GPS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  etaHours, formatEta, weatherFactor, paceFromTrack, routeProgress,
  baseSpeedKmh, isUsablePace, WEATHER_K_MAX, FOOT_BASE_KMH,
} from '@/lib/on-route/eta';

describe('модель времени', () => {
  it('без рельефа — дистанция на базовую скорость', () => {
    const r = etaHours({ distanceKm: 7 });
    expect(r.hours).toBeCloseTo(7 / FOOT_BASE_KMH, 5);
    expect(r.basis).toBe('model');
    expect(r.reliefUsed).toBe(false);
  });

  it('набор высоты добавляет час на 600 м, сброс — час на 1500 м', () => {
    const r = etaHours({ distanceKm: 7, ascentM: 600, descentM: 1500 });
    expect(r.hours).toBeCloseTo(7 / FOOT_BASE_KMH + 1 + 1, 5);
    expect(r.reliefUsed).toBe(true);
  });

  it('сложность правит базу: лёгкий быстрее сложного', () => {
    expect(baseSpeedKmh('foot', 'easy')).toBeGreaterThan(baseSpeedKmh('foot', 'hard'));
    expect(baseSpeedKmh('car')).toBeGreaterThan(baseSpeedKmh('foot', 'easy'));
  });

  it('на авто-плече рельеф не учитывается: 31 км это переезд, а не подъём', () => {
    const car = etaHours({ distanceKm: 31.6, ascentM: 800, mode: 'car' });
    expect(car.reliefUsed).toBe(false);
    expect(car.hours!).toBeLessThan(1.5);
    // То же плечо пешком — принципиально другой продукт на одном экране.
    const foot = etaHours({ distanceKm: 31.6, ascentM: 800, mode: 'foot' });
    expect(foot.hours!).toBeGreaterThan(8);
  });

  it('нулевая или битая дистанция — null, а не «0ч 00м»', () => {
    for (const d of [0, -5, NaN, Infinity]) {
      expect(etaHours({ distanceKm: d }).hours).toBeNull();
    }
  });
});

describe('живой темп GPS', () => {
  it('годный темп смешивается с моделью и виден в basis', () => {
    const r = etaHours({ distanceKm: 10, recentPaceKmh: 5 });
    expect(r.basis).toBe('pace+model');
    const byPace = 10 / 5;
    const model = 10 / FOOT_BASE_KMH;
    expect(r.hours).toBeCloseTo(0.6 * byPace + 0.4 * model, 5);
  });

  it('привал и телепорт в темп не проходят', () => {
    for (const p of [0, 0.2, 9, 120, NaN, null, undefined]) {
      expect(isUsablePace(p as number | null), `темп ${p}`).toBe(false);
    }
    expect(isUsablePace(4.5)).toBe(true);
    // На машине разумный коридор другой.
    expect(isUsablePace(45, 'car')).toBe(true);
    expect(isUsablePace(45, 'foot')).toBe(false);
  });

  it('темп надо заработать: короткое окно не даёт числа (вместо нуля — «уточняется»)', () => {
    const t0 = 1_700_000_000_000;
    const short = [
      { lat: 53.0, lng: 158.0, t: t0 },
      { lat: 53.01, lng: 158.0, t: t0 + 60_000 },
    ];
    expect(paceFromTrack(short, 900, t0 + 60_000)).toBeNull();
    expect(paceFromTrack([], 900)).toBeNull();
  });

  it('темп по окну считается, когда след достаточно длинный', () => {
    const t0 = 1_700_000_000_000;
    // 20 отсчётов по минуте, ~90 м за минуту → около 5.4 км/ч
    const samples = Array.from({ length: 21 }, (_, i) => ({
      lat: 53 + i * 0.0008,
      lng: 158,
      t: t0 + i * 60_000,
    }));
    const pace = paceFromTrack(samples, 1800, t0 + 20 * 60_000);
    expect(pace).not.toBeNull();
    expect(pace!).toBeGreaterThan(3);
    expect(pace!).toBeLessThan(8);
  });

  it('скачок позиционирования не становится прогнозом', () => {
    const t0 = 1_700_000_000_000;
    const samples = [
      { lat: 53, lng: 158, t: t0 },
      { lat: 53.008, lng: 158, t: t0 + 600_000 },
      // Телепорт на 50 км за минуту — отбрасывается.
      { lat: 53.5, lng: 158, t: t0 + 660_000 },
      { lat: 53.508, lng: 158, t: t0 + 1_200_000 },
    ];
    const pace = paceFromTrack(samples, 1800, t0 + 1_200_000);
    expect(pace!).toBeLessThan(8);
  });
});

describe('погода — множитель с потолком, а не второй прогноз', () => {
  it('ясно — коэффициент единица', () => {
    expect(weatherFactor({ precipMmH: 0, windMs: 3 }).k).toBe(1);
    expect(weatherFactor(null).k).toBe(1);
  });

  it('дождь и ветер складываются слагаемыми, а не перемножаются', () => {
    const f = weatherFactor({ precipMmH: 2.5, windMs: 9 });
    expect(f.k).toBeCloseTo(1.35, 5);
    expect(f.notes).toContain('сильный дождь');
  });

  it('потолок держит прогноз в рамках даже при всех бедах разом', () => {
    const f = weatherFactor({ precipMmH: 4, windMs: 16, visibilityM: 100, snowDepthCm: 20, tempC: -20 });
    expect(f.k).toBe(WEATHER_K_MAX);
  });

  it('гроза и штормовой ветер — не время, а запрет выхода', () => {
    for (const w of [{ hasStormAlert: true }, { precipMmH: 6 }, { windMs: 22 }]) {
      const f = weatherFactor(w);
      expect(f.block).toBe(true);
      expect(f.k).toBe(1);
    }
  });

  it('погода не считается дважды: при живом темпе множитель ослаблен', () => {
    const k = 1.5;
    const noPace = etaHours({ distanceKm: 10, weatherK: k }).hours!;
    const withPace = etaHours({ distanceKm: 10, weatherK: k, recentPaceKmh: 4 }).hours!;
    const model = 10 / FOOT_BASE_KMH;
    expect(noPace).toBeCloseTo(model * k, 5);
    expect(withPace).toBeCloseTo(0.6 * (10 / 4) + 0.4 * (model * 1.25), 5);
  });

  it('множитель ниже единицы или мусорный игнорируется — быстрее модели не бывает', () => {
    const plain = etaHours({ distanceKm: 10 }).hours!;
    for (const k of [0.5, 0, -3, NaN]) {
      expect(etaHours({ distanceKm: 10, weatherK: k }).hours).toBeCloseTo(plain, 5);
    }
  });
});

describe('формат времени', () => {
  it('нет оценки — прочерк, а не нули', () => {
    for (const h of [null, 0, -1, NaN, Infinity]) {
      expect(formatEta(h as number | null)).toBe('—');
    }
  });

  it('короткое плечо — минуты, длинное — без ложной точности до минуты', () => {
    expect(formatEta(0.5)).toBe('30 м');
    expect(formatEta(1.5)).toBe('1 ч 30 м');
    expect(formatEta(4.36)).toBe('4 ч 20 м');
    expect(formatEta(3)).toBe('3 ч');
  });
});

describe('прогресс по маршруту', () => {
  const legs = [10, 20, 30];

  it('на старте — ноль, в конце — сто процентов', () => {
    expect(routeProgress(legs, 0, 10).percent).toBe(0);
    expect(routeProgress(legs, 2, 0).percent).toBe(100);
  });

  it('внутри плеча считается съеденная часть', () => {
    const p = routeProgress(legs, 1, 5); // 10 пройдено + 15 из второго плеча
    expect(p.doneKm).toBeCloseTo(25, 5);
    expect(p.totalKm).toBe(60);
    expect(p.percent).toBe(42);
  });

  it('уход в сторону не даёт отрицательного прогресса', () => {
    const p = routeProgress(legs, 0, 99);
    expect(p.doneKm).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('без плеч прогресса нет — и это не деление на ноль', () => {
    expect(routeProgress([], 0, 5)).toEqual({ totalKm: 0, doneKm: 0, percent: 0 });
  });
});

describe('экран «На маршруте» подключён к движку, а не считает сам', () => {
  const SCREEN = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('три числа хода на экране: осталось, ETA, прогресс', () => {
    expect(SCREEN).toMatch(/formatEta\(eta\.hours\)/);
    expect(SCREEN).toMatch(/routeProgress\(legKms, currentWpIdx, distToNext\)/);
    expect(SCREEN).toMatch(/progress\.percent/);
  });

  it('своей формулы времени на экране нет — она одна, в lib/on-route', () => {
    expect(SCREEN).toMatch(/from '@\/lib\/on-route\/eta'/);
    expect(SCREEN).not.toMatch(/\/\s*600\b.*набор|ascent\s*\/\s*600/);
  });

  it('режим движения спрашивается прямо и переживает перезапуск', () => {
    expect(SCREEN).toMatch(/travelMode/);
    expect(SCREEN).toMatch(/on_route_travel_mode/);
    expect(SCREEN).toMatch(/На машине/);
  });

  it('нет темпа — экран объясняет, а не показывает нули', () => {
    expect(SCREEN).toMatch(/темп появится через 2–3 минуты/);
  });
});
