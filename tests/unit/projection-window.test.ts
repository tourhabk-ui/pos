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
import { projectOnTrack, approachPlan, type GeoPoint } from '@/lib/on-route/approach';
import {
  offTrackThresholdM, fixUsableForNavigation, OFF_TRACK_FLOOR_M, OFF_TRACK_CEIL_M,
} from '@/lib/on-route/fix-quality';

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
    // Проверяется, что путь считается ОТ ВЕДОМОГО положения, а не от свежего
    // глобального поиска. К имени переменной не привязываемся: прежняя
    // редакция ломалась на переименовании, ничего при этом не охраняя.
    expect(screen).toMatch(/approachPlan\([\s\S]{0,400}alongRef\.current\?\.projection/);
  });

  it('смена трека обнуляет историю положения', () => {
    // Иначе положение с прошлого маршрута продолжило бы удерживать окно.
    const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(screen).toMatch(/alongRef\.current = null;[\s\S]{0,40}\[track\]/);
  });
});

describe('порог «я в стороне» растёт с погрешностью фикса', () => {
  it('хорошее небо — узкий порог, но не уже пола', () => {
    // При ±5 м порог в десять метров объявлял бы отходом обход лужи.
    expect(offTrackThresholdM(5)).toBe(OFF_TRACK_FLOOR_M);
  });

  it('плохое небо — порог шире, иначе идущий по тропе «в стороне»', () => {
    // Ровно та ошибка в опасную сторону: ложное «вы в стороне» гонит человека
    // искать тропу, которой он и так держится.
    expect(offTrackThresholdM(60)).toBeGreaterThan(100);
    expect(offTrackThresholdM(45)).toBeGreaterThan(offTrackThresholdM(15));
  });

  it('порог не растёт бесконечно', () => {
    expect(offTrackThresholdM(500)).toBe(OFF_TRACK_CEIL_M);
  });

  it('точность неизвестна — берётся потолок, а не пол', () => {
    // Не знать, насколько врёт датчик, и строго судить человека — худшее
    // из сочетаний.
    expect(offTrackThresholdM(null)).toBe(OFF_TRACK_CEIL_M);
    expect(offTrackThresholdM(NaN)).toBe(OFF_TRACK_CEIL_M);
    expect(offTrackThresholdM(0)).toBe(OFF_TRACK_CEIL_M);
  });

  it('порог доезжает до расчёта пути и меняет вердикт «в стороне»', () => {
    const track = [{ lat: 53, lng: 158 }, { lat: 53.1, lng: 158 }];
    const user = { lat: 53.05, lng: 158.0008 }; // ~53 м вбок
    const strict = approachPlan(user, { lat: 53.09, lng: 158 }, track, null, 0.03)!;
    const loose = approachPlan(user, { lat: 53.09, lng: 158 }, track, null, 0.12)!;
    expect(strict.userOffTrack).toBe(true);
    expect(loose.userOffTrack).toBe(false);
  });

  it('точность не влияет на вопрос «точка стоит в стороне»', () => {
    // Это вопрос данных маршрута, а не GPS: общий порог склеил бы две разные
    // природы обратно в одну.
    const track = [{ lat: 53, lng: 158 }, { lat: 53.1, lng: 158 }];
    const far = { lat: 53.05, lng: 158.4 };
    const a = approachPlan({ lat: 53.05, lng: 158 }, far, track, null, 0.025)!;
    const b = approachPlan({ lat: 53.05, lng: 158 }, far, track, null, 0.12)!;
    expect(a.dataConflict).toBe(b.dataConflict);
    expect(a.targetOffTrack).toBe(b.targetOffTrack);
  });
});

describe('плохой фикс не двигает положение и не выдаётся за свежий', () => {
  it('негодный фикс отсекается до обновления окна', () => {
    expect(fixUsableForNavigation(300)).toBe(false);
    expect(fixUsableForNavigation(20)).toBe(true);
    expect(fixUsableForNavigation(null)).toBe(false);
  });

  it('экран не двигает состояние на негодном фиксе', () => {
    const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(screen).toMatch(/if \(fixUsableForNavigation\([\s\S]{0,60}\)\) \{[\s\S]{0,140}advanceAlong/);
  });

  it('свежесть по-прежнему говорится существующим механизмом, а не новым', () => {
    // Отбросить плохой фикс и молча оставить прежнюю проекцию — это стухшее
    // значение под видом текущего.
    const screen = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(screen).toMatch(/figuresAreLive|figuresLive/);
  });
});
