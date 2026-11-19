/**
 * Какой тур подходит дню зоны (аудит планировщика 07.11, волна 3.4, E4).
 *
 * До 07.11 предикат `ark.zone = $1 OR $1 = 'avachinsky'` брал в Авачинскую
 * зону туры ЛЮБОЙ зоны: западная рыбалка вставала днём в городе без переезда.
 * Теперь тур подходит, если его зона совпала; тур без зоны — городской и
 * подходит только Авачинской. Условие — SQL, его текст судится по смыслу:
 * совпадение зоны, «без зоны — только Авачинская», зона — только параметром.
 * Что движок и список туров дня шлют именно его —
 * tests/unit/planner-zone-crowd.test.ts и проверка роута ниже.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Планер — только после входа (14.11, «6-3»): здесь проверяется сам роут,
// вход держит tests/unit/planner-login-gate.test.tsx.
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { zoneMatchSql, plannerZoneSql } from '@/lib/planner/zone-match';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';

beforeEach(() => { poolQuery.mockReset(); });

describe('предикат зоны', () => {
  const sql = zoneMatchSql('ark', '$1');

  it('зона тура совпала с зоной дня — зона планера: южная по широте, иначе записанная (#3394 п.3)', () => {
    expect(sql).toContain(`${plannerZoneSql('ark')} = $1`);
    // Исполнение на настоящем PostgreSQL — tests/integration/catalog-place-type.pg.test.ts.
  });

  it('тур без зоны — только Авачинской зоне, а не любой тур — Авачинской', () => {
    expect(sql).toMatch(/ark\.zone IS NULL AND \$1 = 'avachinsky'/);
    // Прежнее ослабление: «$1 = 'avachinsky'» без условия на зону тура.
    expect(sql.replace(/ark\.zone IS NULL AND \$1 = 'avachinsky'/, '')).not.toMatch(/'avachinsky'/);
  });

  it('псевдоним и параметр — только имя и $N: зона в SQL строкой не попадает', () => {
    expect(() => zoneMatchSql('ark', "'western'")).toThrow();
    expect(() => zoneMatchSql('ark; DROP', '$1')).toThrow();
    expect(() => plannerZoneSql('r; DROP')).toThrow();
    expect(zoneMatchSql('r', '$2')).toBe(`(${plannerZoneSql('r')} = $2 OR (r.zone IS NULL AND $2 = 'avachinsky'))`);
  });
});

describe('список туров дня в планировщике — тот же предикат', () => {
  it('запрос с зоной шлёт zoneMatchSql, зона — параметром', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=volcano&zone=avachinsky'));
    const [text, params] = poolQuery.mock.calls[0]! as [string, unknown[]];
    expect(text).toContain(zoneMatchSql('ark', '$2'));
    expect(params).toEqual([['volcano'], 'avachinsky']);
  });
});
