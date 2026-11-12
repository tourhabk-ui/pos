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

/**
 * Находка Bugbot к #3235 (11.11): цифра в ответе проверялась раньше слов
 * уровня, и «премиум до 200 тысяч» молча становилось «комфортом»; правка
 * готового плана set_lodging с цифрой отказывала, а заметка при этом
 * говорила «считаю комфорт».
 */
describe('readBudgetTier: уровень рядом с суммой', () => {
  it('прямое слово уровня рядом с суммой сохраняется, сумма названа неучтённой', () => {
    const cases: Array<[string, 'economy' | 'comfort' | 'premium']> = [
      ['премиум до 200 тысяч', 'premium'],
      ['эконом, 50 000 на двоих', 'economy'],
      ['комфорт до 150к', 'comfort'],
      ['люкс 300000', 'premium'],
    ];
    for (const [raw, tier] of cases) {
      const r = readBudgetTier(raw);
      expect(r.tier, raw).toBe(tier);
      expect(r.given, raw).toBe(true);
      expect(r.note, raw).toMatch(/не учитываю: план собирается без потолка цены/);
      expect(r.note, raw).not.toMatch(/считаю на уровне «комфорт»/);
    }
  });

  it('«бюджет» и «дорого» рядом с суммой уровнем не становятся; два уровня — не выбираем', () => {
    for (const raw of ['бюджет 500 тысяч', 'недорого, до 100 000', 'эконом или премиум, до 200 тысяч']) {
      const r = readBudgetTier(raw);
      expect(r.given, raw).toBe(false);
      expect(r.tier, raw).toBe('comfort');
    }
  });
});

describe('правка готового плана: уровень жилья', () => {
  it('set_lodging с суммой и уровнем — правка проходит', async () => {
    const { readPlanEdit } = await import('@/lib/kuzmich/trip-plan-tool');
    const r = readPlanEdit({ action: 'set_lodging', lodging: 'премиум до 200 тысяч' });
    expect(r).toEqual({ ok: true, edit: { kind: 'set_lodging', tier: 'premium' } });
  });

  it('set_lodging без уровня — отказ без слов «считаю комфорт»', async () => {
    const { readPlanEdit } = await import('@/lib/kuzmich/trip-plan-tool');
    for (const lodging of ['до 200 тысяч', 'как получится']) {
      const r = readPlanEdit({ action: 'set_lodging', lodging });
      expect(r.ok, lodging).toBe(false);
      const err = r.ok ? '' : r.error;
      expect(err, lodging).toMatch(/не разобрал — нужно: эконом, комфорт или премиум/);
      expect(err, lodging).not.toMatch(/комфорт»/);
    }
  });
});
