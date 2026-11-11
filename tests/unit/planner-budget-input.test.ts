// @vitest-environment node
/**
 * Бюджет как вход планировщика (#3199, раздел 4).
 *
 * Уровень (эконом / комфорт / премиум) меняет только жильё в смете; числового
 * потолка у плана нет. Прежде «бюджет до 100 000 ₽» читалось по первому слову
 * как «эконом» — молча; память бота записывала «дорога на Мутновский» как
 * «премиум», а «бюджет 500 тысяч» — как «эконом»; поиск MCP на «план на 7
 * дней» искал туры со словом «дней». Судится вызовом.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { readBudgetTier } from '@/lib/kuzmich/trip-plan-tool';
import { extractBotMemoryPatch } from '@/lib/kuzmich/core';
import { SEARCH_TOOL } from '@/lib/mcp/connector-schemas';

describe('readBudgetTier: названная сумма', () => {
  it('сумма не учитывается и это сказано; уровень жилья — комфорт', () => {
    for (const raw of ['до 100 000 ₽', 'бюджет 500 тысяч', '200к на двоих']) {
      const r = readBudgetTier(raw);
      expect(r.tier, raw).toBe('comfort');
      expect(r.given, raw).toBe(false);
      expect(r.note, raw).toMatch(/Сумму «.+» не учитываю: план собирается без потолка цены/);
    }
  });

  it('слова уровня читаются как прежде, без заметки', () => {
    expect(readBudgetTier('эконом')).toEqual({ tier: 'economy', given: true, note: null });
    expect(readBudgetTier('бюджетно')).toEqual({ tier: 'economy', given: true, note: null });
    expect(readBudgetTier('премиум')).toEqual({ tier: 'premium', given: true, note: null });
  });
});

describe('память бота: уровень — по словам об уровне', () => {
  it('«дорога» и «бюджет N тысяч» уровня не задают', () => {
    expect(extractBotMemoryPatch('какая дорога на Мутновский').budget_level).toBeUndefined();
    expect(extractBotMemoryPatch('бюджет 500 тысяч на двоих').budget_level).toBeUndefined();
  });

  it('слова об уровне — задают', () => {
    expect(extractBotMemoryPatch('хотим подешевле, эконом').budget_level).toBe('budget');
    expect(extractBotMemoryPatch('нужен люкс').budget_level).toBe('premium');
  });
});

describe('поиск MCP: план по дням — не его работа, и это сказано', () => {
  it('описание search называет make_trip_plan и планировщик', () => {
    expect(SEARCH_TOOL.description).toMatch(/План поездки по дням search не строит/);
    expect(SEARCH_TOOL.description).toContain('make_trip_plan');
    expect(SEARCH_TOOL.description).toContain('vedarai.ru/planner');
  });
});
