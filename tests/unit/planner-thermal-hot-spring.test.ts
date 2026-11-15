/**
 * «Горячие источники» на сайте и «термальные» в чате — одно занятие
 * (разбор 14.11, Кузьмич-9, и замер с прода через MCP `get_tours`).
 *
 * Пять живых туров к источникам операторы записали типом `thermal`, а
 * планировщик сайта спрашивает плиткой `hot_spring`. Отбор шёл точным
 * равенством, и сайт не ставил в план, в карточку дня, на страницу поездки
 * ни одного такого тура. Чат при этом звал то же занятие ключом `thermal` с
 * другой зоной — по одним словам выходили разные планы.
 *
 * Сторож проверяет вызовом: каждый путь, спрашивающий туры занятия, шлёт в
 * базу и `thermal`, и правила обоих ключей одинаковы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { ACTIVITY_CONSTRAINTS, normalizeActivity, rawTypesFor } from '@/lib/planner/constants';
import { createPlannerCache, fetchRealToursForZone } from '@/lib/planner/data';
import { topToursByActivity } from '@/lib/tours/top-tour-by-activity';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';
import { GET as partners } from '@/app/api/planner/partners/route';

beforeEach(() => { poolQuery.mockReset(); poolQuery.mockResolvedValue({ rows: [] }); });

const sentTypes = (call = 0) => (poolQuery.mock.calls[call]! as [string, unknown[]])[1]
  .find((p): p is string[] => Array.isArray(p));

describe('тип тура `thermal` — это плитка «Горячие источники»', () => {
  it('слово оператора переводится на ключ плитки, плитка ищет оба слова', () => {
    expect(normalizeActivity('thermal')).toBe('hot_spring');
    expect(rawTypesFor('hot_spring')).toEqual(['hot_spring', 'thermal']);
    // Ключ чата находит туры своим словом.
    expect(rawTypesFor('thermal')).toContain('thermal');
  });

  it('правила занятия одни у обоих ключей: сезон, зоны, дети, транспорт', () => {
    expect(ACTIVITY_CONSTRAINTS.thermal).toEqual(ACTIVITY_CONSTRAINTS.hot_spring);
  });
});

describe('каждый путь планировщика спрашивает и `thermal`', () => {
  it('движок: туры зоны для дня «Горячие источники»', async () => {
    await fetchRealToursForZone('avachinsky', 'hot_spring', 3, createPlannerCache());
    expect(sentTypes()).toEqual(['hot_spring', 'thermal']);
  });

  it('карточка дня: /api/planner/tours-for-day', async () => {
    await toursForDay(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=hot_spring'));
    expect(sentTypes()).toEqual(['hot_spring', 'thermal']);
  });

  it('страница поездки и плана: тур вида для дня без тура', async () => {
    await topToursByActivity(['hot_spring']);
    expect(sentTypes()).toEqual(['hot_spring', 'thermal']);
  });

  it('операторы дня: у кого есть туры вида', async () => {
    await partners(new NextRequest('http://localhost/api/planner/partners?activity_type=hot_spring'));
    expect(sentTypes()).toEqual(['hot_spring', 'thermal']);
  });
});
