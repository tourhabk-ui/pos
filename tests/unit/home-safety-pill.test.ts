/**
 * Статус-пилюля главной говорит только то, что мы знаем.
 *
 * Макет предлагал «СЕГОДНЯ · 12/16 ОТКРЫТО». Такой дроби взять неоткуда: зон в
 * системе четыре (avachinsky/western/eastern/northern), районного статуса не
 * существует, а `location_real_time_status` считается по 763 точкам. Показать
 * красивую дробь означало бы придумать знаменатель — на платформе, которая
 * обещает не врать цифрами.
 *
 * Отдельная тонкость: счётчик приходит из выборки с LIMIT 5. Ровная «5» на
 * витрине при десяти реальных предупреждениях — тихое занижение, поэтому у
 * потолка пишем «5+».
 */
import { describe, it, expect } from 'vitest';
import { safetyPill, pluralWarnings } from '@/lib/home/safety-pill';

describe('пилюля обстановки', () => {
  it('нет активных предупреждений — спокойно', () => {
    expect(safetyPill({ activeCount: 0, maxSeverity: 0 })).toEqual({
      tone: 'calm', text: 'Сегодня: спокойно',
    });
  });

  it('severity 2 и выше — опасность, без счёта', () => {
    // Тот же порог, по которому уходит push и краснеет recommender_status.
    // Человеку в этот момент не нужно число, ему нужно слово.
    const p = safetyPill({ activeCount: 3, maxSeverity: 2 });
    expect(p.tone).toBe('danger');
    expect(p.text).toBe('Сегодня: опасность');
  });

  it('мягкие предупреждения считаются', () => {
    expect(safetyPill({ activeCount: 1, maxSeverity: 1 }).text).toBe('Сегодня: 1 предупреждение');
    expect(safetyPill({ activeCount: 2, maxSeverity: 1 }).text).toBe('Сегодня: 2 предупреждения');
  });

  it('на потолке выборки — «5+», а не ровная пятёрка', () => {
    const p = safetyPill({ activeCount: 5, maxSeverity: 1 });
    expect(p.text).toBe('Сегодня: 5+ предупреждений');
    expect(p.tone).toBe('warning');
  });

  it('дроби в тексте нет ни при каком состоянии', () => {
    // Сторож против возвращения «12 из 16»: знаменателя у нас не существует.
    for (const input of [
      { activeCount: 0, maxSeverity: 0 },
      { activeCount: 1, maxSeverity: 0 },
      { activeCount: 4, maxSeverity: 1 },
      { activeCount: 5, maxSeverity: 1 },
      { activeCount: 9, maxSeverity: 3 },
    ]) {
      expect(safetyPill(input).text).not.toMatch(/\d\s*(\/|из)\s*\d/);
    }
  });
});

describe('склонение', () => {
  it('русские формы, включая 11-14', () => {
    expect(pluralWarnings(1)).toBe('предупреждение');
    expect(pluralWarnings(3)).toBe('предупреждения');
    expect(pluralWarnings(5)).toBe('предупреждений');
    expect(pluralWarnings(11)).toBe('предупреждений');
    expect(pluralWarnings(12)).toBe('предупреждений');
    expect(pluralWarnings(21)).toBe('предупреждение');
    expect(pluralWarnings(22)).toBe('предупреждения');
  });
});
