/**
 * Счёт замера моделей погоды (#2249): суточные суммы, «сухо / осадки»,
 * рейтинг. Сеть здесь не участвует — только арифметика, которая может молча
 * соврать: неполные сутки за «сухо», ноль дней за идеальную точность.
 */

import { describe, it, expect } from 'vitest';
import {
  dailySums, scoreForecast, rankModels, pickDayOffset, KAMCHATKA_UTC_OFFSET_H,
  type SkillScore,
} from '@/lib/weather/model-skill';

/** Часы UTC подряд, начиная с `start` (YYYY-MM-DDTHH:00). */
function hours(start: string, count: number): string[] {
  const t0 = Date.parse(`${start}Z`);
  return Array.from({ length: count }, (_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16));
}

describe('dailySums', () => {
  it('местные сутки Камчатки начинаются в 12:00 UTC предыдущего дня', () => {
    // 48 часов с 2026-10-04T12:00Z — ровно местные 05.10 и 06.10.
    const t = hours('2026-10-04T12:00', 48);
    const v = t.map((_, i) => (i < 24 ? 0.5 : 0));
    const local = dailySums(t, v, KAMCHATKA_UTC_OFFSET_H);
    expect([...local.entries()]).toEqual([['2026-10-05', 12], ['2026-10-06', 0]]);
  });

  it('те же часы по UTC: неполные края не считаются', () => {
    const t = hours('2026-10-04T12:00', 48);
    const utc = dailySums(t, t.map(() => 0.5), 0);
    // 04.10 — 12 часов, 06.10 — 12 часов: в счёт идёт только 05.10.
    expect([...utc.keys()]).toEqual(['2026-10-05']);
    expect(utc.get('2026-10-05')).toBe(12);
  });

  it('пустой час — сутки выпадают, а не считаются сухими', () => {
    const t = hours('2026-10-04T12:00', 24);
    const v: Array<number | null> = t.map(() => 0);
    v[7] = null;
    expect(dailySums(t, v, KAMCHATKA_UTC_OFFSET_H).size).toBe(0);
  });
});

describe('scoreForecast', () => {
  const obs = new Map([['d1', 0], ['d2', 5], ['d3', 0.2], ['d4', 12], ['d5', 0]]);

  it('таблица сопряжённости и доли', () => {
    const fc = new Map([['d1', 19], ['d2', 4], ['d3', 0], ['d4', 0.3], ['d5', 0]]);
    const s = scoreForecast(obs, fc, { wetMm: 1 });
    expect(s).toMatchObject({ n: 5, hits: 1, misses: 1, falseAlarms: 1, correctDry: 2 });
    expect(s.accuracy).toBe(0.6);
    expect(s.pod).toBe(0.5);
    expect(s.far).toBe(0.5);
    // 19 мм на сухой день — тот самый «сильный ливень» 06.10.
    expect(s.falseHeavy).toBe(1);
  });

  it('сравнивает только общие дни', () => {
    const s = scoreForecast(obs, new Map([['d2', 3], ['zz', 50]]), { wetMm: 1 });
    expect(s.n).toBe(1);
    expect(s.accuracy).toBe(1);
  });

  it('ноль общих дней — «не с чем сравнить», а не идеальная точность', () => {
    const s = scoreForecast(obs, new Map([['zz', 0]]), { wetMm: 1 });
    expect(s.n).toBe(0);
    expect(s.accuracy).toBeNull();
    expect(s.biasMm).toBeNull();
  });

  it('доли без знаменателя — null', () => {
    const dry = new Map([['a', 0], ['b', 0]]);
    const s = scoreForecast(dry, new Map([['a', 0], ['b', 0]]), { wetMm: 1 });
    expect(s.accuracy).toBe(1);
    expect(s.pod).toBeNull();
    expect(s.far).toBeNull();
  });
});

const sc = (over: Partial<SkillScore>): SkillScore => ({
  n: 30, hits: 0, misses: 0, falseAlarms: 0, correctDry: 0, accuracy: 0.5,
  pod: null, far: null, biasMm: 0, maeMm: 1, falseHeavy: 0, ...over,
});

describe('rankModels', () => {
  it('по точности, затем по ложным ливням, затем по ошибке', () => {
    const { ranked } = rankModels([
      { model: 'a', score: sc({ accuracy: 0.7, falseHeavy: 3 }) },
      { model: 'b', score: sc({ accuracy: 0.8 }) },
      { model: 'c', score: sc({ accuracy: 0.7, falseHeavy: 1, maeMm: 3 }) },
      { model: 'd', score: sc({ accuracy: 0.7, falseHeavy: 1, maeMm: 2 }) },
    ]);
    expect(ranked.map((r) => r.model)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('мало дней — не в рейтинге, а названо отдельно', () => {
    const { ranked, insufficient } = rankModels([
      { model: 'lucky', score: sc({ n: 8, accuracy: 1 }) },
      { model: 'real', score: sc({ accuracy: 0.75 }) },
      { model: 'empty', score: sc({ n: 0, accuracy: null }) },
    ]);
    expect(ranked.map((r) => r.model)).toEqual(['real']);
    expect(insufficient.map((r) => r.model)).toEqual(['lucky', 'empty']);
  });
});

describe('pickDayOffset', () => {
  it('выбирает сдвиг суток, при котором модели совпадают с фактом лучше', () => {
    const r = pickDayOffset(new Map([
      [0, [sc({ accuracy: 0.6 }), sc({ accuracy: 0.62 })]],
      [6, [sc({ accuracy: 0.81 }), sc({ accuracy: 0.79 })]],
      [12, [sc({ accuracy: 0.7 }), sc({ accuracy: 0.72 })]],
    ]));
    expect(r.best).toBe(6);
    expect(r.means.get(0)).toBeCloseTo(0.61);
  });

  it('первые два в пределах шума — не решено', () => {
    expect(pickDayOffset(new Map([[6, [sc({ accuracy: 0.71 })]], [12, [sc({ accuracy: 0.7 })]]])).best).toBeNull();
  });

  it('у сдвига без точности нет голоса; ни у кого нет — не решено', () => {
    expect(pickDayOffset(new Map([[0, [sc({ accuracy: null })]], [12, [sc({ accuracy: 0.7 })]]])).best).toBe(12);
    expect(pickDayOffset(new Map([[0, [sc({ accuracy: null })]]])).best).toBeNull();
  });
});
