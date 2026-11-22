/**
 * Ночёвка только там, где она есть (аудит дорог 22.11, п. 3): ночь вне
 * Авачинской зоны без тура с проживанием — только при жилье зоны на
 * платформе; иначе — строка на днях этих ночей. Без БД: счёт подменён.
 */
import { describe, it, expect } from 'vitest';
import { checkNights, nightGapLine, zoneLodgingCountSql } from '@/lib/planner/night-check';
import { readFileSync } from 'node:fs';

type D = Parameters<typeof checkNights>[0][number];
const day = (n: number, type: string, zone: D['zone'], lodging: boolean | null = null, tourId = `t${n}`, first = true): D =>
  ({ day: n, type, zone, title: `День ${n}`, dayWarnings: [], realTour: lodging === null ? null : { tourId, lodgingIncluded: lodging },
    ...(lodging !== null && first ? { realPrice: 1000 } : {}) });

describe('ночёвка вне Авачинской зоны', () => {
  it('жилья зоны нет — строка на ночах; ночь в туре с проживанием не считается', async () => {
    // Дни 3–4 — двухдневный тур с проживанием: ночь после дня 3 — в туре,
    // после дня 4 (последнего) — уже нет.
    const days = [day(1, 'arrival', 'avachinsky'), day(2, 'travel', 'avachinsky'), day(3, 'activity', 'western', true, 'tw'),
      day(4, 'activity', 'western', true, 'tw', false), day(5, 'travel', 'western'), day(6, 'departure', 'avachinsky')];
    const asked: string[] = [];
    const gaps = await checkNights(days, async (z) => { asked.push(z); return 0; }, '2027-07-10');
    expect(asked).toEqual(['western']);
    expect(gaps).toEqual([{ zone: 'western', days: [2, 4], kind: 'none' }]);
    expect(days[1].dayWarnings[0]).toContain('Западная зона, ночи 11.07, 13.07 — жилья этой зоны на платформе нет');
    expect(days[2].dayWarnings).toHaveLength(0);
    expect(days[3].dayWarnings).toHaveLength(1);
    // День переезда обратно ночует уже в Авачинской.
    expect(days[4].dayWarnings).toHaveLength(0);
  });

  it('жильё есть — молчим; не прочиталось — «не проверено», а не «нет»', async () => {
    const days = [day(1, 'activity', 'eastern', false), day(2, 'departure', 'avachinsky')];
    expect(await checkNights(days, async () => 3)).toEqual([]);
    const gaps = await checkNights(days, async () => null);
    expect(gaps[0].kind).toBe('unread');
    expect(nightGapLine(gaps[0])).toContain('проверить жильё этой зоны не вышло');
  });

  it('Северная и Южная ночуют в Авачинской — их не проверяем; счёт живой, в движке без кэша', async () => {
    const days = [day(1, 'activity', 'northern', false), day(2, 'activity', 'southern', false), day(3, 'departure', 'avachinsky')];
    expect(await checkNights(days, async () => 0)).toEqual([]);
    expect(zoneLodgingCountSql('TRUE')).toMatch(/planner_zone = \$1/);
    const engine = readFileSync('lib/planner/engine.ts', 'utf8');
    const at = engine.indexOf('const nightGaps = await checkNights(');
    expect(at).toBeGreaterThan(0);
    expect(engine.slice(at, at + 600)).toContain('pool.query');
    expect(engine.slice(at, at + 600)).not.toMatch(/cache/i);
  });
});

import { roadDayLine } from '@/lib/planner/road-reach';
describe('строка дороги дня', () => {
  it('часы — «оценка», сезонность — «нет в официальных источниках», без выдуманных дат', () => {
    const line = roadDayLine({ km: 106, hours: 2.0 });
    expect(line).toContain('106 км, ≈2 ч по дороге в одну сторону (оценка');
    expect(line).toContain('в официальных источниках у нас нет');
    expect(line).not.toMatch(/\d{2}\.\d{2}/);
  });
});
