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
import { readFileSync } from 'fs';
import { join } from 'path';
import { safetyPill, pluralWarnings } from '@/lib/home/safety-pill';

describe('пилюля обстановки', () => {
  it('нет активных предупреждений — спокойно', () => {
    expect(safetyPill({ activeCount: 0, maxSeverity: 0 })).toEqual({
      tone: 'calm', text: 'Спокойно',
    });
  });

  it('severity 2 и выше — опасность, без счёта', () => {
    // Тот же порог, по которому уходит push и краснеет recommender_status.
    // Человеку в этот момент не нужно число, ему нужно слово.
    const p = safetyPill({ activeCount: 3, maxSeverity: 2 });
    expect(p.tone).toBe('danger');
    expect(p.text).toBe('Опасность');
  });

  it('мягкие предупреждения считаются', () => {
    expect(safetyPill({ activeCount: 1, maxSeverity: 1 }).text).toBe('1 предупреждение');
    expect(safetyPill({ activeCount: 2, maxSeverity: 1 }).text).toBe('2 предупреждения');
  });

  it('на потолке выборки — «5+», а не ровная пятёрка', () => {
    const p = safetyPill({ activeCount: 5, maxSeverity: 1 });
    expect(p.text).toBe('5+ предупреждений');
    expect(p.tone).toBe('warning');
  });

  it('ноль предупреждений при недоступной сводке — «Нет данных», а не «Спокойно»', () => {
    // Аудит 24.09 (#37/#44): «Спокойно» в шапке рядом с «Обстановка
    // недоступна» строкой ниже. Незнание — третий исход (§4.0), не хорошая новость.
    expect(safetyPill({ activeCount: 0, maxSeverity: 0, freshness: 'unavailable' }))
      .toEqual({ tone: 'unknown', text: 'Нет данных' });
    expect(safetyPill({ activeCount: 0, maxSeverity: 0, freshness: 'fresh' }).tone).toBe('calm');
  });

  it('недоступная сводка не глушит известную опасность', () => {
    // Предупреждения пришли из ленты — о них надо сказать, даже если другой
    // источник молчит.
    expect(safetyPill({ activeCount: 2, maxSeverity: 2, freshness: 'unavailable' }).tone).toBe('danger');
    expect(safetyPill({ activeCount: 1, maxSeverity: 1, freshness: 'unavailable' }).tone).toBe('warning');
  });

  it('главная передаёт в пилюлю свежесть, а бейдж «Сегодня спокойно» требует и спокойствия, и свежести', () => {
    const src = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
    const call = /safetyPill\(\{[^}]*\}\)/.exec(src)?.[0] ?? '';
    expect(call, 'пилюля снова считается без свежести').toMatch(/freshness:\s*fresh\.state/);
    const badgeAt = src.indexOf('Сегодня спокойно</span>');
    expect(badgeAt, 'бейдж не найден').toBeGreaterThan(0);
    const guard = src.slice(Math.max(0, badgeAt - 200), badgeAt);
    expect(guard).toMatch(/pill\.tone === 'calm'/);
    expect(guard, 'бейдж снова не смотрит на свежесть').toMatch(/fresh\.state === 'fresh'/);
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

describe('статус безопасности не обрезается', () => {
  it('текст короткий — влезает в узкую шапку', () => {
    // Живой отказ 29.07 на экране 1080px: пилюля ужалась до «Сегодня: оп».
    // Обрезанная «опасность» выглядит как исправный индикатор и не читается —
    // хуже, чем отсутствие индикатора вовсе. Порог грубый, но он ловит
    // возвращение длинных формулировок вроде «Сегодня: N предупреждений».
    for (const input of [
      { activeCount: 0, maxSeverity: 0 },
      { activeCount: 1, maxSeverity: 1 },
      { activeCount: 5, maxSeverity: 1 },
      { activeCount: 2, maxSeverity: 3 },
    ]) {
      expect(safetyPill(input).text.length, `слишком длинно: ${safetyPill(input).text}`)
        .toBeLessThanOrEqual(18);
    }
  });

  it('в стилях пилюли нет многоточия и она не сжимается', () => {
    const src = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
    const rule = /\.v7 \.pill\{[^}]*\}/.exec(src)?.[0] ?? '';
    expect(rule, 'не разобрать правило .pill').not.toBe('');
    expect(rule, 'обрезка статуса безопасности вернулась').not.toContain('text-overflow');
    expect(rule, 'пилюля снова сжимается соседями').toContain('flex:none');
  });
});
