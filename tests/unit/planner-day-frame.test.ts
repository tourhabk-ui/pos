/**
 * Подпись «Прилёт»/«Вылет» и запрет двигать день — по типу дня (разбор
 * планера 14.11, экран-8): у жителя края таких дней нет.
 */
import { describe, it, expect } from 'vitest';
import { dayFrame } from '@/lib/planner/day-frame';

describe('рамка поездки — по типу дня', () => {
  it('прилёт и отъезд прилетающего — подписаны и закреплены, рейс — если назван', () => {
    expect(dayFrame({ type: 'arrival' })).toEqual({ badge: 'Прилёт', locked: true });
    expect(dayFrame({ type: 'departure' }, { departure: 'SU1730' })).toEqual({ badge: 'SU1730', locked: true });
  });

  it('у местного первый и последний день — занятия: без подписи рейса и не закреплены', () => {
    for (const type of ['activity', 'rest', 'travel', 'buffer']) {
      expect(dayFrame({ type }, { arrival: '08:30', departure: '18:00' })).toEqual({ locked: false });
    }
  });
});
