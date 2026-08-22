/**
 * У совпадения имени есть потолок расстояния (владелец 23.08).
 *
 * Правило «имя сильнее близости» стояло без ограничения. Сухой прогон
 * подсказчика на 140 местах без маршрута показал цену: 36 мест «с
 * кандидатами», из которых честных — пять. Остальное:
 *
 *   Большие Тюшевские источники → одноимённый маршрут  · 329 км
 *   Дранкинские источники       → одноимённый маршрут  · 220 км
 *   Корякский ЗАПОВЕДНИК (север) → Вулкан Корякский    · 851 км, имя 1.0
 *   Кальдера Призрак            → «Посёлок-призрак.»   · 243 км, имя 1.0
 *
 * Совпало слово, а не предмет. Оправданием правила была парковка в трёх
 * километрах — три, не восемьсот.
 *
 * Такая пара перестаёт быть кандидатом на связь и становится УЛИКОЙ: одна
 * из двух координат врёт. Выбрасывать её нельзя — по ней чинят координаты.
 */
import { describe, it, expect } from 'vitest';
import {
  suggestRoutes, conflictingPairs, classifyPair, NAME_MATCH_MAX_KM,
  type RouteCandidateInput,
} from '@/lib/routes/place-link';

/** Корякский заповедник (север края) и вулкан Корякский (у Петропавловска). */
const ZAPOVEDNIK = { id: 'p1', name: 'Корякский природный заповедник', lat: 60.0, lng: 166.0 };
const VULKAN: RouteCandidateInput = {
  id: 'r1', title: 'Вулкан Корякский', lat: 53.32, lng: 158.71,
  hasGeometry: true, waypointCount: 5,
};
/** Видовка и маршрут на неё же — 0.6 км, честная пара. */
const VIDOVKA = { id: 'p2', name: 'Видовка на горе Верблюд', lat: 53.36, lng: 158.72 };
const VERBLYUD: RouteCandidateInput = {
  id: 'r2', title: 'Экструзия Верблюд', lat: 53.365, lng: 158.72,
  hasGeometry: true, waypointCount: 1,
};

describe('род пары: связь, улика или незнание', () => {
  it('близко — связь', () => {
    expect(classifyPair(1, 0.6)).toBe('link');
    expect(classifyPair(0.5, NAME_MATCH_MAX_KM)).toBe('link');
  });

  it('имя совпало, а далеко — улика, а не связь', () => {
    expect(classifyPair(1, 851)).toBe('conflict');
    expect(classifyPair(0.5, NAME_MATCH_MAX_KM + 0.1)).toBe('conflict');
  });

  it('расстояние неизвестно — «не знаю», и это не улика', () => {
    // Третий исход не равен ни первому, ни второму: решает человек (§4.0).
    expect(classifyPair(1, null)).toBe('unknown');
    expect(classifyPair(0, null)).toBe('unknown');
  });

  it('без совпадения имени далёкая пара уликой не становится', () => {
    // Улика — это ПРОТИВОРЕЧИЕ: имя говорит «одно и то же», расстояние
    // говорит «разное». Без имени противоречия нет.
    expect(classifyPair(0, 851)).toBe('link');
  });
});

describe('подсказчик не предлагает заведомую чушь', () => {
  it('одноимённый объект за 851 км в кандидаты не идёт', () => {
    const out = suggestRoutes(ZAPOVEDNIK, [VULKAN]);
    expect(out.map(c => c.routeId)).not.toContain('r1');
  });

  it('честная пара в кандидатах остаётся', () => {
    const out = suggestRoutes(VIDOVKA, [VERBLYUD]);
    expect(out.map(c => c.routeId)).toContain('r2');
  });

  it('городской старт не отсекается: до цели бывает и двадцать пять км', () => {
    // Ровно этот случай уронил первую редакцию потолка (25 км): маршрут
    // «Восхождение на Авачинский вулкан» со стартом в городе.
    const avacha = { id: 'p3', name: 'Вулкан Авачинский', lat: 53.26, lng: 158.83 };
    const routeFromCity: RouteCandidateInput = {
      id: 'r4', title: 'Восхождение на Авачинский вулкан', lat: 53.05, lng: 158.68,
      hasGeometry: true, waypointCount: 1,
    };
    expect(suggestRoutes(avacha, [routeFromCity]).map(c => c.routeId)).toContain('r4');
    expect(conflictingPairs(avacha, [routeFromCity])).toEqual([]);
  });
});

describe('улики не теряются', () => {
  it('далёкий одноимённый попадает в конфликты с расстоянием', () => {
    const c = conflictingPairs(ZAPOVEDNIK, [VULKAN]);
    expect(c).toHaveLength(1);
    expect(c[0].routeTitle).toBe('Вулкан Корякский');
    expect(c[0].distanceKm).toBeGreaterThan(800);
    expect(c[0].nameScore).toBeGreaterThan(0);
  });

  it('честная пара уликой не считается', () => {
    expect(conflictingPairs(VIDOVKA, [VERBLYUD])).toEqual([]);
  });

  it('место без координаты улик не даёт — судить нечем', () => {
    expect(conflictingPairs({ ...ZAPOVEDNIK, lat: null, lng: null }, [VULKAN])).toEqual([]);
  });

  it('дальние идут первыми: чем больше расхождение, тем очевиднее ошибка', () => {
    const near: RouteCandidateInput = {
      id: 'r3', title: 'Корякский перевал', lat: 54.0, lng: 166.5,
      hasGeometry: true, waypointCount: 0,
    };
    const c = conflictingPairs(ZAPOVEDNIK, [near, VULKAN]);
    expect(c.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < c.length; i++) {
      expect(c[i - 1].distanceKm).toBeGreaterThanOrEqual(c[i].distanceKm);
    }
  });
});

describe('потолок назван и объяснён', () => {
  it('потолок щедрее дневного перехода, но не сотни километров', () => {
    // Координата маршрута обычно в начале пути, объект — в дне ходьбы.
    // Замер 23.08: честные пары 0.6-25.4 км, ложные от 133. Потолок обязан
    // накрывать городской старт (до Мутновского ~70 км) и не дотягиваться
    // до первой ложной.
    expect(NAME_MATCH_MAX_KM).toBeGreaterThanOrEqual(70);
    expect(NAME_MATCH_MAX_KM).toBeLessThan(133);
  });
});
