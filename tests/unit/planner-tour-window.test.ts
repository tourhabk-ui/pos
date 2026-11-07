/**
 * Срез туров зоны — после окна поездки (аудит планировщика 07.11, волна 3.5,
 * E5).
 *
 * Туры упорядочивались по ближайшему выезду вообще и срезались по числу дней
 * блока раньше, чем движок смотрел окно поездки: тур с выездами в дни
 * поездки уступал место туру с выездом завтра. Теперь у плана с датами
 * «ближайший выезд» правила 1в считается в днях поездки. Проверено на
 * настоящем PostgreSQL (описание PR); здесь — смысл условия и что движок и
 * отбор передают окно.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { nearestFreeDateInWindowSql, nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { createPlannerCache, fetchRealToursForZone } from '@/lib/planner/data';

beforeEach(() => { poolQuery.mockReset(); poolQuery.mockResolvedValue({ rows: [] }); });

describe('ближайший выезд в окне поездки', () => {
  const sql = nearestFreeDateInWindowSql('ot', '$3', '$4');

  it('дата не раньше начала окна и сегодняшнего дня, не позже конца окна, со свободными местами', () => {
    expect(sql).toMatch(/date >= GREATEST\(\$3::date, \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date\)/);
    expect(sql).toMatch(/date <= \$4::date/);
    expect(sql).toMatch(/> 0/);
    expect(sql).toMatch(/ORDER BY ta_nw\.date\s+LIMIT 1/);
  });

  it('алиас и параметры — только имя и $N', () => {
    expect(() => nearestFreeDateInWindowSql('ot', "'2027-07-10'", '$4')).toThrow();
    expect(() => nearestFreeDateInWindowSql('ot; x', '$3', '$4')).toThrow();
  });
});

describe('отбор туров зоны передаёт окно', () => {
  it('с окном — даты параметрами и условие окна; без окна — прежний ближайший выезд', async () => {
    await fetchRealToursForZone('avachinsky', 'volcano', 3, createPlannerCache(), { from: '2027-07-10', to: '2027-07-16' });
    const [withSql, withParams] = poolQuery.mock.calls[0]! as [string, unknown[]];
    expect(withSql).toContain(nearestFreeDateInWindowSql('ot', '$3', '$4'));
    expect(withParams.slice(2)).toEqual(['2027-07-10', '2027-07-16']);

    await fetchRealToursForZone('avachinsky', 'volcano', 3, createPlannerCache());
    const [noSql, noParams] = poolQuery.mock.calls[1]! as [string, unknown[]];
    expect(noSql).toContain(nearestFreeDateSql('ot'));
    expect(noParams).toHaveLength(2);
  });

  it('окно — в ключе кэша: тот же кэш с окном и без него спрашивает базу дважды', async () => {
    const cache = createPlannerCache();
    await fetchRealToursForZone('avachinsky', 'volcano', 3, cache, { from: '2027-07-10', to: '2027-07-16' });
    await fetchRealToursForZone('avachinsky', 'volcano', 3, cache);
    await fetchRealToursForZone('avachinsky', 'volcano', 3, cache, { from: '2027-07-10', to: '2027-07-16' });
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });
});
