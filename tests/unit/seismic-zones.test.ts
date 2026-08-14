/**
 * Далёкое землетрясение не красит маршруты, до которых не достаёт.
 *
 * В ingestUsgs зона выводилась делением координат пополам:
 *   lat >= 55.5 → northern; lng >= 161 → eastern; иначе avachinsky.
 * Расстояние не учитывалось, пустого исхода не существовало — любая точка
 * внутри запроса обязательно становилась чьей-то зоной.
 *
 * `affected_zones` кормит location_real_time_status, а тот красит карточки
 * маршрутов: 11.08 одна протухшая запись держала 137 маршрутов из 421 в
 * статусе «Не сегодня». Ложная привязка доезжает до экрана туриста.
 *
 * Координаты ниже настоящие; расстояния сверены расчётом по большому кругу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  zonesForEpicenter,
  kmToNearestTouristArea,
  distanceKm,
  MAX_RELEVANT_KM,
} from '@/lib/services/safety/seismic-zones';

describe('расстояние считается верно', () => {
  it('Петропавловск — Ключевская сопка ≈ 360 км', () => {
    const d = distanceKm(53.01, 158.65, 56.06, 160.64);
    expect(d).toBeGreaterThan(340);
    expect(d).toBeLessThan(385);
  });

  it('точка сама с собой — ноль', () => {
    expect(distanceKm(53.01, 158.65, 53.01, 158.65)).toBeCloseTo(0, 5);
  });
});

describe('близкие события привязываются', () => {
  it('Мутновский — зона Авачинского', () => {
    expect(zonesForEpicenter(52.45, 158.20)).toEqual(['avachinsky']);
  });

  it('Ключевская группа — северная зона', () => {
    expect(zonesForEpicenter(56.06, 160.64)).toEqual(['northern']);
  });

  it('Кроноцкий попадает в «avachinsky» — грубость старого деления, не правка', () => {
    // Кроноцкий стоит на восточном побережье, но долгота 160.53 не дотягивает
    // до порога 161, и старое деление относит его к зоне Авачинского. Эта
    // правка деление НЕ трогает: у тревожных зон нет координат, и придумать
    // их означало бы выдать догадку за геодезию. Тест закрепляет текущее
    // поведение честным именем, чтобы неточность была видна, а не забыта.
    expect(zonesForEpicenter(54.75, 160.53)).toEqual(['avachinsky']);
  });
});

describe('далёкие события не привязываются ни к чему', () => {
  it('Командорские острова — зон нет', () => {
    // 536 км от Петропавловска, через океан. Прежний код отдавал ['eastern']
    // и красил восточные маршруты землетрясением, которого там не слышно.
    const km = kmToNearestTouristArea(55.20, 165.98);
    expect(km).toBeGreaterThan(MAX_RELEVANT_KM);
    expect(zonesForEpicenter(55.20, 165.98)).toEqual([]);
  });

  it('север края (Палана) — зон нет', () => {
    expect(zonesForEpicenter(59.10, 159.95)).toEqual([]);
  });

  it('пустой ответ — это ответ, а не сбой', () => {
    // Событие сохраняется и видно в сейсмоленте; не привязывается только к
    // маршрутам. Молчаливое исчезновение было бы другим дефектом.
    const zones = zonesForEpicenter(59.10, 159.95);
    expect(Array.isArray(zones)).toBe(true);
    expect(zones).toHaveLength(0);
  });
});

describe('правило применено в приёме', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');

  it('ingestUsgs зовёт общую функцию, а не делит координаты сам', () => {
    expect(SRC).toMatch(/zonesForEpicenter\(lat, lng\)/);
    expect(SRC).not.toMatch(/lat >= 55\.5\s*\n?\s*\?\s*\['northern'\]/);
  });

  it('порог расстояния живёт в одном месте', () => {
    // Копия порога в другом файле разошлась бы так же, как разошлись сегодня
    // список глаголов, стиль линии, тип ключа и сверка секрета.
    const zonesSrc = readFileSync(
      join(process.cwd(), 'lib/services/safety/seismic-zones.ts'), 'utf-8',
    );
    expect(zonesSrc).toMatch(/export const MAX_RELEVANT_KM/);
    expect(SRC).not.toMatch(/250/);
  });

  it('координаты районов берутся из общего справочника зон', () => {
    // Свой список координат стал бы вторым источником истины о географии.
    const zonesSrc = readFileSync(
      join(process.cwd(), 'lib/services/safety/seismic-zones.ts'), 'utf-8',
    );
    expect(zonesSrc).toMatch(/from '@\/lib\/services\/safety\/zone-weather'/);
  });
});
