/**
 * Положение вдоль маршрута не скачет, пока человек стоит.
 *
 * `projectOnTrack` ищет глобально ближайшее звено на каждом фиксе. На
 * радиальном маршруте трек идёт туда и обратно, обе ветки в десятках метров
 * друг от друга, и шум позиционирования перекидывает проекцию со ветки «туда»
 * на ветку «обратно»: «осталось 3 км» становится «осталось 17 км» у
 * НЕПОДВИЖНОГО человека.
 *
 * Это не неточность. Прибор, чьи показания скачут втрое, пока стоишь на месте,
 * перестают читать — и тогда неважно, насколько он точен в остальном.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  advanceAlong, WINDOW_M, RESET_OFF_TRACK_KM, type AlongState,
} from '@/lib/on-route/projection-window';
import { projectOnTrack, type GeoPoint } from '@/lib/on-route/approach';

/**
 * Радиальный маршрут: на север по 158.000 и обратно на юг по 158.0005.
 * Ветки в ~33 метрах друг от друга — ближе, чем шум GPS в горах.
 */
const RADIAL: GeoPoint[] = [
  ...Array.from({ length: 21 }, (_, i) => ({ lat: 53 + i * 0.001, lng: 158.0000 })),
  ...Array.from({ length: 21 }, (_, i) => ({ lat: 53.02 - i * 0.001, lng: 158.0005 })),
];

/** Человек на ветке «туда», примерно на трети пути. */
const ON_WAY_OUT: GeoPoint = { lat: 53.007, lng: 158.0000 };

function seed(user: GeoPoint): AlongState {
  return advanceAlong(user, RADIAL, null)!;
}

describe('глобальный поиск действительно перескакивает — вот ради чего окно', () => {
  it('шум в тридцать метров переносит проекцию на встречную ветку', () => {
    // Проверяем сам дефект, а не только лекарство: без этого тест-лекарство
    // ничего не значил бы.
    const out = projectOnTrack(ON_WAY_OUT, RADIAL)!;
    const noisy = projectOnTrack({ lat: 53.007, lng: 158.0006 }, RADIAL)!;
    expect(Math.abs(noisy.segment - out.segment)).toBeGreaterThan(10);
  });
});

describe('окно держит положение', () => {
  it('человек стоит, координата дрожит — положение почти не меняется', () => {
    let st = seed(ON_WAY_OUT);
    const start = st.alongM;
    for (const dLng of [0.0004, -0.0002, 0.0006, 0.0001, 0.0005]) {
      st = advanceAlong({ lat: 53.007, lng: 158.0 + dLng }, RADIAL, st)!;
    }
    // Разброс десятками метров допустим, километрами — нет.
    expect(Math.abs(st.alongM - start)).toBeLessThan(WINDOW_M);
  });

  it('без окна тот же дрейф даёт скачок на километры', () => {
    let st = seed(ON_WAY_OUT);
    const withWindow = advanceAlong({ lat: 53.007, lng: 158.0006 }, RADIAL, st)!;
    const globalOnly = advanceAlong({ lat: 53.007, lng: 158.0006 }, RADIAL, null)!;
    expect(Math.abs(withWindow.alongM - st.alongM)).toBeLessThan(WINDOW_M);
    expect(Math.abs(globalOnly.alongM - st.alongM)).toBeGreaterThan(1000);
  });

  it('человек идёт вперёд — положение растёт', () => {
    let st = seed({ lat: 53.001, lng: 158.0 });
    const first = st.alongM;
    for (let i = 2; i <= 8; i++) {
      st = advanceAlong({ lat: 53 + i * 0.001, lng: 158.0 }, RADIAL, st)!;
    }
    expect(st.alongM).toBeGreaterThan(first + 500);
  });

  it('идущий назад по своим следам не блокируется окном', () => {
    // Возврат — законное движение, особенно на радиальном маршруте.
    let st = seed({ lat: 53.008, lng: 158.0 });
    const top = st.alongM;
    for (let i = 7; i >= 4; i--) {
      st = advanceAlong({ lat: 53 + i * 0.001, lng: 158.0 }, RADIAL, st)!;
    }
    expect(st.alongM).toBeLessThan(top);
  });
});

describe('когда состояние мешает — от него отказываются', () => {
  it('первый фикс ищется глобально', () => {
    const st = advanceAlong(ON_WAY_OUT, RADIAL, null);
    expect(st).not.toBeNull();
  });

  it('ушёл с маршрута далеко — поиск снова глобальный', () => {
    const st = seed(ON_WAY_OUT);
    // За километр от трека прошлое положение уже не про этого человека.
    const far: GeoPoint = { lat: 53.018, lng: 158.03 };
    const next = advanceAlong(far, RADIAL, st)!;
    expect(next.alongM).not.toBeCloseTo(st.alongM, 0);
    expect(RESET_OFF_TRACK_KM).toBeGreaterThan(0);
  });

  it('трек короче двух точек — положения нет вовсе', () => {
    expect(advanceAlong(ON_WAY_OUT, [], null)).toBeNull();
    expect(advanceAlong(ON_WAY_OUT, [{ lat: 53, lng: 158 }], null)).toBeNull();
  });
});

describe('окно выбрано так, чтобы встречная ветка в него не попадала', () => {
  it('триста метров — меньше, чем длина ветки радиального маршрута', () => {
    // Иначе противоположная ветка окажется внутри окна, и вернётся ровно тот
    // перескок, ради которого всё написано.
    expect(WINDOW_M).toBeLessThan(1000);
    expect(WINDOW_M).toBeGreaterThan(100);
  });
});

describe('экран действительно ведёт положение состоянием', () => {
  it('окно подключено к расчёту пути, а не лежит библиотекой', () => {
    // Правило, которое некому вызвать, — мёртвое правило.
    const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(screen).toMatch(/advanceAlong\(/);
    expect(screen).toMatch(/approachPlan\([\s\S]{0,200}next\?\.projection/);
  });

  it('смена трека обнуляет историю положения', () => {
    // Иначе положение с прошлого маршрута продолжило бы удерживать окно.
    const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(screen).toMatch(/alongRef\.current = null;[\s\S]{0,40}\[track\]/);
  });
});
