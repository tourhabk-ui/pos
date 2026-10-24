import { describe, it, expect } from 'vitest';
import { tourFitsTripMonth } from '@/lib/planner/tour-season';

const july = (title: string, seasonStart: string | null = null, seasonEnd: string | null = null) =>
  tourFitsTripMonth({ title, seasonStart, seasonEnd, month: 7 });

describe('тур на день — по месяцу поездки', () => {
  it('июль не получает зимнюю рыбалку и тур, названный январём', () => {
    expect(july('Зимняя рыбалка: январь')).toBe(false);
    expect(july('Зимняя рыбалка')).toBe(false);
  });

  it('июльская рыбалка и тур без сезона остаются', () => {
    expect(july('Рыбалка на чавычу')).toBe(true);
    expect(july('Выход к бухте')).toBe(true);
  });

  it('«маяк» — не май', () => {
    expect(july('Маяк')).toBe(true);
    expect(july('Рыбалка в мае')).toBe(false);
  });

  it('окно сезона только когда записаны обе даты', () => {
    expect(july('Бухта', '2026-11-01', '2027-03-31')).toBe(false);
    expect(tourFitsTripMonth({ title: 'Бухта', seasonStart: '2026-11-01', seasonEnd: '2027-03-31', month: 1 })).toBe(true);
    expect(july('Бухта', '2026-11-01', null)).toBe(true);
  });

  it('месяц вне 1–12 — не подходит, а не «любой тур»', () => {
    expect(tourFitsTripMonth({ title: 'Бухта', seasonStart: null, seasonEnd: null, month: 0 })).toBe(false);
  });
});
