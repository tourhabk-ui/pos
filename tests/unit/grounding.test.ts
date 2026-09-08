/**
 * tests/unit/grounding.test.ts
 *
 * Метрика заземления: конкретика (цены/телефоны/наличие мест) в ответе
 * без вызова инструментов данных = незаземлённые факты (CLAUDE.md §8).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectFactSignals, ranDataTool, assessGrounding } from '@/lib/agents/eval/grounding';

describe('detectFactSignals', () => {
  it('находит цены в разных форматах', () => {
    expect(detectFactSignals('Тур стоит 15000 ₽ с человека')).toContain('price');
    expect(detectFactSignals('Цена 15 000 руб за день')).toContain('price');
    expect(detectFactSignals('от 20 тыс. рублей')).toContain('price');
  });

  it('находит телефоны, но не экстренные', () => {
    expect(detectFactSignals('Звоните оператору +7 962 215-33-44')).toContain('phone');
    // Экстренные номера из кода платформы — легитимны без инструментов
    expect(detectFactSignals('Звоните 112 или ГУ МЧС +7 (4152) 23-53-62')).not.toContain('phone');
  });

  it('находит заявления о наличии мест', () => {
    expect(detectFactSignals('На эту дату есть места, бронируйте')).toContain('availability');
    expect(detectFactSignals('Осталось 3 места на субботу')).toContain('availability');
  });

  it('не флагует обычный рассказ о месте', () => {
    expect(detectFactSignals('Авачинский вулкан высотой 2741 метр, подъём занимает 6-8 часов')).toEqual([]);
    expect(detectFactSignals('Лучший сезон — с июля по сентябрь')).toEqual([]);
  });
});

const ran = (name: string) => ({ name, producedData: true });
const empty = (name: string) => ({ name, producedData: false });

describe('ranDataTool', () => {
  it('распознаёт инструменты данных, принёсшие результат', () => {
    expect(ranDataTool([ran('search_kamchatka')])).toBe(true);
    expect(ranDataTool([ran('get_guardian_context')])).toBe(true);
    expect(ranDataTool([empty('search_taaft'), ran('search_accommodations')])).toBe(true);
  });

  it('пустой список — нет заземления', () => {
    expect(ranDataTool([])).toBe(false);
  });

  // Находка аудита 08.09: имя выполненного инструмента считалось
  // доказательством. Поиск, вернувший «ничего не найдено», выполнился —
  // и цена, взятая из головы, после него числилась заземлённой.
  it('инструмент отработал, но данных не принёс — не заземляет', () => {
    expect(ranDataTool([empty('search_kamchatka')])).toBe(false);
    expect(ranDataTool([empty('search_kamchatka'), empty('get_tour_details')])).toBe(false);
  });
});

describe('assessGrounding', () => {
  it('цена без инструментов — незаземлено', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', []);
    expect(result.verdict).toBe('ungrounded');
    expect(result.signals).toContain('price');
    expect(result.reason).toContain('не вызывались');
  });

  it('цена после search-инструмента с данными — заземлено', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', [ran('search_kamchatka')]);
    expect(result.verdict).toBe('grounded');
    expect(result.signals).toContain('price');
  });

  it('цена после ПУСТОГО поиска — незаземлено, и причина названа', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', [empty('search_kamchatka')]);
    expect(result.verdict).toBe('ungrounded');
    expect(result.reason).toContain('search_kamchatka');
    expect(result.reason).toContain('данных не принесли');
  });

  // Третий исход (§4.0): журнала вызовов нет — судить не о чем.
  // Прежде здесь молча возвращалось «заземлено».
  it('журнал вызовов не передан — «не знаю», а не «заземлено»', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', undefined);
    expect(result.verdict).toBe('unknown');
    expect(result.verdict).not.toBe('grounded');
    expect(result.signals).toContain('price');
  });

  it('без конкретики отсутствие журнала ничего не меняет — заземлять нечего', () => {
    expect(assessGrounding('Ключевская Сопка — высочайший вулкан Евразии', undefined).verdict)
      .toBe('grounded');
  });

  it('рассказ без конкретики — не флагуется даже без инструментов', () => {
    const result = assessGrounding('Ключевская Сопка — высочайший действующий вулкан Евразии', []);
    expect(result.verdict).toBe('grounded');
    expect(result.signals).toEqual([]);
  });

  it('SOS-блок с 112 и каноническим МЧС не считается незаземлённым телефоном', () => {
    const sos = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ:\nЗвоните 112.\nГУ МЧС по Камчатскому краю: +7 (4152) 23-53-62.';
    expect(assessGrounding(sos, []).verdict).toBe('grounded');
  });
});

describe('исход инструмента судит один реестр (core.ts)', () => {
  it('«данных нет» и пустая строка не считаются данными', async () => {
    const { toolOutputHasData } = await import('@/lib/kuzmich/core');
    expect(toolOutputHasData('Поиск не дал результатов.')).toBe(false);
    expect(toolOutputHasData('Туры не найдены.')).toBe(false);
    expect(toolOutputHasData('Ошибка при выполнении запроса.')).toBe(false);
    expect(toolOutputHasData('   ')).toBe(false);
  });

  it('ответы с запросом человека судятся по неизменной голове', () => {
    // Раньше эти два возврата собирались прямо в месте использования, и
    // судить их было нечем: проза целиком зависела от текста туриста.
    const SRC = readFileSync('lib/kuzmich/core.ts', 'utf8');
    expect(SRC).toMatch(/const noTourFound = \(q: string\)/);
    expect(SRC).toMatch(/const noPlaceInBase = \(n: string\)/);
  });

  it('настоящий результат считается данными', async () => {
    const { toolOutputHasData } = await import('@/lib/kuzmich/core');
    expect(toolOutputHasData('ID12: Восхождение на Авачинский, 25000 руб')).toBe(true);
  });
});
