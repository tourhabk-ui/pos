/**
 * «Живые на маршрутах» под турами главной — без слов-заглушек (П8, #36/#40).
 *
 * При нулях блок подставлял «Маршруты / исследовать» и «Исследователь / Ваш
 * стиль»; у tourists_hour нет писателя, броней до первых продаж нет — значит
 * на проде он был ТОЛЬКО заглушкой. Теперь нули → блока нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveCounters } from '@/lib/home/live-counters';

describe('liveCounters', () => {
  it('нет данных → нули', () => {
    expect(liveCounters(null)).toEqual({ touristsOnTrail: 0, bookingsToday: 0 });
  });
  it('суммирует людей по маршрутам и берёт брони', () => {
    expect(liveCounters({ bookings_today: 3, active_routes: [{ tourists_hour: 2 }, { tourists_hour: 5 }] }))
      .toEqual({ touristsOnTrail: 7, bookingsToday: 3 });
  });
  it('мусор и отрицательное — не люди', () => {
    expect(liveCounters({ bookings_today: -1, active_routes: [{ tourists_hour: null }, { tourists_hour: Number.NaN }] }))
      .toEqual({ touristsOnTrail: 0, bookingsToday: 0 });
  });
  it('строка из COUNT(*)::text читается числом', () => {
    expect(liveCounters({ bookings_today: '2' as unknown as number }).bookingsToday).toBe(2);
  });
});

describe('компонент LiveOnTrails', () => {
  // Код без комментариев: шапка файла рассказывает историю словами прежних
  // заглушек, и сторож не должен путать рассказ с кодом.
  const SRC = readFileSync(join(process.cwd(), 'components/homepage/LiveOnTrails.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('оба счётчика нулевые → null, а не заглушка', () => {
    expect(SRC).toMatch(/if \(touristsOnTrail === 0 && bookingsToday === 0\) return null;/);
    expect(SRC).not.toMatch(/Исследователь|Ваш стиль|'исследовать'/);
  });

  it('каждый счётчик рисуется только при значении больше нуля', () => {
    expect(SRC).toMatch(/\{touristsOnTrail > 0 && \(/);
    expect(SRC).toMatch(/\{bookingsToday > 0 && \(/);
  });

  it('отказ запроса не глушится', () => {
    expect(SRC).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(SRC).toMatch(/console\.warn\('\[home\] live-feed не загружен/);
  });

  it('брони склоняются через plural', () => {
    expect(SRC).toMatch(/plural\(bookingsToday, 'бронь', 'брони', 'броней'\)/);
    expect(SRC).not.toMatch(/\$\{bookingsToday\} броней/);
  });
});
