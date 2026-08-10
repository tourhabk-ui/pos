/**
 * Свежесть наблюдения KVERT на бейдже вулкана.
 *
 * Инцидент 26.07–01.08: синк авиационных кодов лёг (kscnet.ru сменил VONA на
 * HTML), но бейдж показывал замороженный цвет как текущий. Устаревший ЗЕЛЁНЫЙ
 * опаснее всего — вулкан мог эскалировать, а мы бы не знали. Проверка
 * цвето-независима и мягкая (nudge «сверь», не ложная тревога).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  volcanoObservationAgeDays, isVolcanoObservationStale, formatObservationAge, VOLCANO_STALE_DAYS,
} from '@/lib/services/safety/kvert-vona';

const NOW = new Date('2026-08-01T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('возраст наблюдения', () => {
  it('считает дни, пол не уходит в минус', () => {
    expect(volcanoObservationAgeDays(daysAgo(0), NOW)).toBe(0);
    expect(volcanoObservationAgeDays(daysAgo(25), NOW)).toBe(25);
    expect(volcanoObservationAgeDays(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe(0);
  });
  it('null/битая дата → null', () => {
    expect(volcanoObservationAgeDays(null, NOW)).toBeNull();
    expect(volcanoObservationAgeDays('не дата', NOW)).toBeNull();
  });
});

describe('порог протухания', () => {
  it('свежее порога — не устарело; на пороге и старше — устарело', () => {
    expect(isVolcanoObservationStale(daysAgo(VOLCANO_STALE_DAYS - 1), NOW)).toBe(false);
    expect(isVolcanoObservationStale(daysAgo(VOLCANO_STALE_DAYS), NOW)).toBe(true);
    expect(isVolcanoObservationStale(daysAgo(30), NOW)).toBe(true);
  });
  it('нет даты → не устарело (нечего пугать)', () => {
    expect(isVolcanoObservationStale(null, NOW)).toBe(false);
  });
});

describe('русская форма возраста', () => {
  it('склонения', () => {
    expect(formatObservationAge(0)).toBe('сегодня');
    expect(formatObservationAge(1)).toBe('вчера');
    expect(formatObservationAge(2)).toBe('2 дня назад');
    expect(formatObservationAge(5)).toBe('5 дней назад');
    expect(formatObservationAge(11)).toBe('11 дней назад');
    expect(formatObservationAge(21)).toBe('21 день назад');
    expect(formatObservationAge(25)).toBe('25 дней назад');
  });
});

describe('бейдж рисует плашку протухания', () => {
  const badge = readFileSync(join(process.cwd(), 'components/places/VolcanoAccBadge.tsx'), 'utf-8');
  it('плашка под флагом stale, цвето-независимо', () => {
    expect(badge).toMatch(/const stale = isVolcanoObservationStale/);
    expect(badge).toMatch(/\{stale &&/);
    expect(badge).toMatch(/не обновлялись/);
    expect(badge).toMatch(/сверьте текущий код на KVERT/);
  });
  it('возраст показан рядом с датой наблюдения', () => {
    expect(badge).toMatch(/formatObservationAge\(ageDays\)/);
  });
});

describe('источник KVERT — живой домен, не мёртвый kscnet.ru', () => {
  const sync = readFileSync(join(process.cwd(), 'lib/agents/kvert-sync.ts'), 'utf-8');
  it('DEFAULT_KVERT_URL на kvert.febras.net (kscnet.ru отдаёт 404 с 01.08)', () => {
    // Стережём СВОЙСТВО адреса, а не его написание. Прежде здесь стояла
    // полная строка вместе с query — и 10.08 этот сторож не пустил правку,
    // которая делала источник надёжнее (добавляла lend=en против однобайтовой
    // кодировки русской версии). Гард, прибитый к формулировке, ловит не
    // регресс, а любое изменение — и приучает себя обходить.
    const url = /const DEFAULT_KVERT_URL = '([^']+)'/.exec(sync)?.[1] ?? '';
    expect(url, 'адрес ленты KVERT потерялся').toContain('kvert.febras.net');
    expect(url, 'вернулся мёртвый домен kscnet.ru — крон снова ляжет').not.toContain('kscnet.ru');
  });
});
