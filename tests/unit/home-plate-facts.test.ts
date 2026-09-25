/**
 * Факты карточки тура на мобильной главной (аудит 24.09, #39/#122).
 *
 * Было: «от 13 000 ₽ · тур оператора» — без единицы цены, без длительности,
 * со словом-заглушкой вместо имени оператора, которое в базе есть. Правило
 * §4.0: чего нет в данных — выпадает из строки, а не подменяется.
 */
import { describe, it, expect } from 'vitest';
import { plateFacts, plateDuration } from '@/lib/home/plate-facts';

const base = {
  priceFrom: 13000, priceUnit: 'per_person', durationType: 'single_day',
  multiDayCount: null, durationHours: 10, operatorName: 'Камчатка Семейный Рафтинг',
};

describe('строка фактов карточки', () => {
  it('цена с единицей, длительность и имя оператора', () => {
    const f = plateFacts(base);
    expect(f.price).toBe('от 13 000 ₽ /чел.');
    expect(f.duration).toBe('10 ч');
    expect(f.operator).toBe('Камчатка Семейный Рафтинг');
  });

  it('единица цены — та же, что в каталоге, а не всегда «за человека»', () => {
    expect(plateFacts({ ...base, priceUnit: 'per_tour' }).price).toBe('от 13 000 ₽ /группа');
  });

  it('нет цены — null, а не «от 0 ₽»', () => {
    expect(plateFacts({ ...base, priceFrom: null }).price).toBeNull();
    expect(plateFacts({ ...base, priceFrom: 0 }).price).toBeNull();
  });

  it('нет оператора — null, а не «тур оператора»', () => {
    expect(plateFacts({ ...base, operatorName: null }).operator).toBeNull();
    expect(plateFacts({ ...base, operatorName: '  ' }).operator).toBeNull();
  });

  it('длительность склоняется и не выдумывается', () => {
    expect(plateDuration({ durationType: 'multi_day', multiDayCount: 2, durationHours: 48 })).toBe('2 дня');
    expect(plateDuration({ durationType: 'multi_day', multiDayCount: 5, durationHours: 120 })).toBe('5 дней');
    expect(plateDuration({ durationType: 'multi_day', multiDayCount: 21, durationHours: null })).toBe('21 день');
    expect(plateDuration({ durationType: 'half_day', multiDayCount: null, durationHours: null })).toBe('Полдня');
    expect(plateDuration({ durationType: null, multiDayCount: null, durationHours: 72 })).toBe('3 дня');
    expect(plateDuration({ durationType: null, multiDayCount: null, durationHours: null })).toBeNull();
  });
});
