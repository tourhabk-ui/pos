/**
 * tests/unit/grounding.test.ts
 *
 * Метрика заземления: конкретика (цены/телефоны/наличие мест) в ответе
 * без вызова инструментов данных = незаземлённые факты (CLAUDE.md §8).
 */

import { describe, it, expect } from 'vitest';
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

describe('ranDataTool', () => {
  it('распознаёт инструменты данных', () => {
    expect(ranDataTool(['search_kamchatka'])).toBe(true);
    expect(ranDataTool(['get_guardian_context'])).toBe(true);
    expect(ranDataTool(['search_accommodations', 'search_taaft'])).toBe(true);
  });

  it('пустой список — нет заземления', () => {
    expect(ranDataTool([])).toBe(false);
  });
});

describe('assessGrounding', () => {
  it('цена без инструментов — незаземлено', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', []);
    expect(result.ungrounded).toBe(true);
    expect(result.signals).toContain('price');
  });

  it('цена после search-инструмента — заземлено', () => {
    const result = assessGrounding('Этот тур стоит 25000 рублей', ['search_kamchatka']);
    expect(result.ungrounded).toBe(false);
    expect(result.signals).toContain('price');
  });

  it('рассказ без конкретики — не флагуется даже без инструментов', () => {
    const result = assessGrounding('Ключевская Сопка — высочайший действующий вулкан Евразии', []);
    expect(result.ungrounded).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it('SOS-блок с 112 и каноническим МЧС не считается незаземлённым телефоном', () => {
    const sos = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ:\nЗвоните 112.\nГУ МЧС по Камчатскому краю: +7 (4152) 23-53-62.';
    expect(assessGrounding(sos, []).ungrounded).toBe(false);
  });
});
