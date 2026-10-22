import { describe, it, expect } from 'vitest';
import { mchsQueryFor } from '@/components/trips/TripActions';

describe('mchsQueryFor', () => {
  it('несёт название, дни и даты, без ПД', () => {
    const q = new URLSearchParams(mchsQueryFor({
      id: 'x', title: 'Вулканы', arrival_date: '2027-07-01T00:00:00.000Z', departure_date: '2027-07-05',
      days: [{ day: 1, title: 'Авачинский' }, { day: 2, title: 'Мутновский' }],
    }));
    expect(q.get('name')).toBe('Вулканы');
    expect(q.get('desc')).toBe('День 1: Авачинский\nДень 2: Мутновский');
    expect(q.get('start')).toBe('2027-07-01');
    expect(q.get('end')).toBe('2027-07-05');
    expect([...q.keys()].sort()).toEqual(['desc', 'end', 'name', 'start']);
  });
});
