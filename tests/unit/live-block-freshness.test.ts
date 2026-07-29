/**
 * Свежесть обстановки на главной: три состояния, а не одно.
 *
 * Молча показать позавчерашнюю сводку как сегодняшнюю — это то же враньё, от
 * которого мы чистили календарь тура: интерфейс выглядит рабочим, а человек
 * принимает решение по данным, которых больше нет. На слое безопасности это
 * дороже пустого места.
 *
 * Поэтому «нет данных» и «данные старые» обязаны выглядеть по-разному, и ни
 * одно из них не должно выглядеть как «всё хорошо».
 */
import { describe, it, expect } from 'vitest';
import {
  dataFreshness,
  freshnessDot,
  humanAge,
  STALE_AFTER_MINUTES,
} from '@/lib/home/data-freshness';

const NOW = new Date('2026-07-29T12:00:00Z');
const agoMin = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe('свежие данные', () => {
  it('показывают возраст и зелёную точку', () => {
    const f = dataFreshness({ updatedAt: agoMin(18), source: 'safety', now: NOW });
    expect(f.state).toBe('fresh');
    expect(f.ageMinutes).toBe(18);
    expect(f.label).toBe('Обновлено 18 минут назад');
    expect(freshnessDot(f.state)).toBe('var(--success)');
  });

  it('совсем свежие — «только что», а не «0 минут назад»', () => {
    expect(dataFreshness({ updatedAt: agoMin(0), source: 'safety', now: NOW }).label)
      .toBe('Обновлено только что');
  });
});

describe('устаревшие данные названы устаревшими', () => {
  it('за порогом источника состояние меняется на stale', () => {
    const overSafety = STALE_AFTER_MINUTES.safety + 60;
    const f = dataFreshness({ updatedAt: agoMin(overSafety), source: 'safety', now: NOW });
    expect(f.state).toBe('stale');
    expect(f.label).toMatch(/^Данные /);
    expect(freshnessDot(f.state)).toBe('var(--warning)');
  });

  it('порог зависит от источника: час тишины сейсмики уже подозрителен', () => {
    // Землетрясения идут потоком; ACC вулканов меняется раз в сутки. Общий
    // порог «ну пусть час» соврал бы в обе стороны.
    const ninety = agoMin(90);
    expect(dataFreshness({ updatedAt: ninety, source: 'seismic', now: NOW }).state).toBe('stale');
    expect(dataFreshness({ updatedAt: ninety, source: 'volcano', now: NOW }).state).toBe('fresh');
  });
});

describe('недоступный источник не притворяется свежим', () => {
  it.each([
    ['пустая строка', ''],
    ['null', null],
    ['undefined', undefined],
    ['мусор вместо даты', 'позавчера'],
  ])('%s → «недоступно» и БЕЗ зелёной точки', (_name, value) => {
    const f = dataFreshness({ updatedAt: value as string | null, source: 'safety', now: NOW });
    expect(f.state).toBe('unavailable');
    expect(f.label).toBe('Обстановка недоступна');
    expect(f.ageMinutes).toBeNull();
    // Главное: никакой зелёной точки. Зелёное = «всё проверено и хорошо».
    expect(freshnessDot(f.state)).toBeNull();
  });

  it('время из будущего — тоже «недоступно», а не «только что»', () => {
    // Рассинхрон часов или битая запись. Отрицательный возраст выглядел бы
    // как самые свежие данные на свете.
    const future = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    expect(dataFreshness({ updatedAt: future, source: 'safety', now: NOW }).state)
      .toBe('unavailable');
  });
});

describe('возраст по-русски', () => {
  it.each([
    [1, '1 минуту назад'],
    [2, '2 минуты назад'],
    [5, '5 минут назад'],
    [21, '21 минуту назад'],
    [60, '1 час назад'],
    [122, '2 часа назад'],
    [300, '5 часов назад'],
    [1440, '1 день назад'],
    [2880, '2 дня назад'],
    [7200, '5 дней назад'],
  ])('%i минут → «%s»', (minutes, expected) => {
    expect(humanAge(minutes as number)).toBe(expected);
  });
});
