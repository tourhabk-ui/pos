/**
 * Публичный MCP не наказывает агента за угаданное имя аргумента (02.10).
 *
 * Панель владельца: у get_place_info 13 ошибок из 87, get_tour_details 6,
 * get_tour_availability и get_guardian_context по 3. «Места нет» пишется
 * успехом, значит это отказы схемы: `place` вместо `name`, `tour_id` вместо
 * `tour`. Синонимы сводятся к каноническому имени до исполнителя.
 */
import { describe, it, expect } from 'vitest';
import { validateToolArgs, TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

const ok = (name: string, args: Record<string, unknown>) => {
  const r = validateToolArgs(name, args as Record<string, string>);
  if (!r.ok) throw new Error(r.error);
  return r.args;
};

describe('get_place_info', () => {
  it('name, place, query, location — всё сводится к name', () => {
    expect(ok('get_place_info', { name: 'Курильское озеро' })).toEqual({ name: 'Курильское озеро' });
    expect(ok('get_place_info', { place: 'Курильское озеро' })).toEqual({ name: 'Курильское озеро' });
    expect(ok('get_place_info', { query: 'Курильское озеро' })).toEqual({ name: 'Курильское озеро' });
    expect(ok('get_place_info', { location: 'Курильское озеро' })).toEqual({ name: 'Курильское озеро' });
  });
  it('каноническое имя важнее синонима', () => {
    expect(ok('get_place_info', { name: 'А', place: 'Б' })).toEqual({ name: 'А' });
  });
  it('без названия — понятный отказ, а не пустой поиск', () => {
    const r = validateToolArgs('get_place_info', {} as Record<string, string>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/нужно указать name/);
  });
  it('постороннее поле со строкой за название не принимается', () => {
    expect(validateToolArgs('get_place_info', { phone: '+79001234567' } as Record<string, string>).ok).toBe(false);
  });
});

describe('get_guardian_context', () => {
  it('name, query, location — сводятся к place', () => {
    expect(ok('get_guardian_context', { name: 'Авачинский' })).toEqual({ place: 'Авачинский' });
    expect(ok('get_guardian_context', { query: 'Авачинский' })).toEqual({ place: 'Авачинский' });
    expect(ok('get_guardian_context', { location: 'Авачинский' })).toEqual({ place: 'Авачинский' });
  });
});

describe('get_tour_details', () => {
  it('tour_id числом, id, title — сводятся к name', () => {
    expect(ok('get_tour_details', { tour_id: 37 })).toEqual({ name: '37' });
    expect(ok('get_tour_details', { id: '37' })).toEqual({ name: '37' });
    expect(ok('get_tour_details', { query: 'рыбалка' })).toEqual({ name: 'рыбалка' });
  });
});

describe('get_tour_availability', () => {
  it('name/tour_id и start_date сводятся к tour и date_from', () => {
    expect(ok('get_tour_availability', { tour_id: 27, start_date: '2027-07-15', days: 7 }))
      .toEqual({ tour: '27', date_from: '2027-07-15', days: '7' });
    expect(ok('get_tour_availability', { name: 'сплав' })).toEqual({ tour: 'сплав', date_from: undefined, days: undefined });
  });
  it('без тура — отказ с подсказкой', () => {
    const r = validateToolArgs('get_tour_availability', { days: '7' } as Record<string, string>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/нужно указать tour/);
  });
});

describe('модели объявлено одно имя — синонимы не рекламируются', () => {
  it('JSON-схема get_place_info по-прежнему требует name', () => {
    const def = TOOL_REGISTRY.get_place_info.definition.function.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(def.required).toEqual(['name']);
    expect(Object.keys(def.properties)).not.toContain('place');
  });
});
