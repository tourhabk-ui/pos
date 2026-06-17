import { describe, it, expect } from 'vitest';
import {
  decideEscalation,
  tripKindFromDates,
  resolveControlTime,
} from './checkin-escalation';

const h = (n: number) => n * 3_600_000; // часы → мс

// Фиксированное контрольное время: вчера в 18:00
const CONTROL = new Date('2026-06-16T18:00:00Z');

const after = (ms: number) => new Date(CONTROL.getTime() + ms);

describe('tripKindFromDates', () => {
  it('один день → day', () => {
    const d = new Date('2026-07-10');
    expect(tripKindFromDates(d, d)).toBe('day');
  });

  it('разные даты → multi', () => {
    expect(tripKindFromDates(new Date('2026-07-10'), new Date('2026-07-20'))).toBe('multi');
  });
});

describe('resolveControlTime', () => {
  it('если expected_return_at задан — использует его', () => {
    const t = new Date('2026-07-10T15:30:00Z');
    expect(resolveControlTime(new Date('2026-07-10'), t)).toBe(t);
  });

  it('если null — fallback на end_date 20:00', () => {
    const ct = resolveControlTime(new Date('2026-07-10'), null);
    expect(ct.getHours()).toBe(20);
  });
});

describe('decideEscalation — однодневка (day)', () => {
  it('0.5ч просрочки → null (ещё нет)', () => {
    expect(decideEscalation(CONTROL, 'day', [], null, after(h(0.5)))).toBeNull();
  });

  it('1ч просрочки → soft', () => {
    const r = decideEscalation(CONTROL, 'day', [], null, after(h(1)));
    expect(r?.step).toBe('soft');
  });

  it('3ч просрочки → hard', () => {
    const r = decideEscalation(CONTROL, 'day', [], null, after(h(3)));
    expect(r?.step).toBe('hard');
  });

  it('8ч просрочки → mchs', () => {
    const r = decideEscalation(CONTROL, 'day', [], null, after(h(8)));
    expect(r?.step).toBe('mchs');
  });

  it('soft уже отправлен, 3ч → hard', () => {
    const r = decideEscalation(CONTROL, 'day', ['soft'], null, after(h(3)));
    expect(r?.step).toBe('hard');
  });

  it('все шаги уже отправлены → null', () => {
    expect(decideEscalation(CONTROL, 'day', ['soft', 'hard', 'mchs'], null, after(h(10)))).toBeNull();
  });

  it('подтверждение ПОСЛЕ контрольного времени гасит тревогу', () => {
    const confirmed = after(h(0.5)); // подтвердил через 30 мин после просрочки
    expect(decideEscalation(CONTROL, 'day', [], confirmed, after(h(2)))).toBeNull();
  });

  it('подтверждение ДО контрольного времени не гасит будущие просрочки', () => {
    const oldConfirm = new Date(CONTROL.getTime() - h(5)); // 5ч ДО контрольного
    const r = decideEscalation(CONTROL, 'day', [], oldConfirm, after(h(4)));
    expect(r?.step).toBe('hard');
  });
});

describe('decideEscalation — многодневка (multi)', () => {
  it('2ч просрочки → null (мягкий шаг только через 3ч)', () => {
    expect(decideEscalation(CONTROL, 'multi', [], null, after(h(2)))).toBeNull();
  });

  it('3ч просрочки → soft', () => {
    const r = decideEscalation(CONTROL, 'multi', [], null, after(h(3)));
    expect(r?.step).toBe('soft');
  });

  it('6ч просрочки → hard', () => {
    const r = decideEscalation(CONTROL, 'multi', [], null, after(h(6)));
    expect(r?.step).toBe('hard');
  });

  it('18ч просрочки → mchs', () => {
    const r = decideEscalation(CONTROL, 'multi', [], null, after(h(18)));
    expect(r?.step).toBe('mchs');
  });

  it('однодневка и многодневка дают разные пороги', () => {
    // 3.5ч — hard для day (порог 3ч), soft для multi (порог 3ч soft / 6ч hard)
    const threeHalf = after(h(3.5));
    expect(decideEscalation(CONTROL, 'day',   [], null, threeHalf)?.step).toBe('hard');
    expect(decideEscalation(CONTROL, 'multi', [], null, threeHalf)?.step).toBe('soft');
  });
});

describe('decideEscalation — hoursOverdue', () => {
  it('возвращает точные часы просрочки', () => {
    const r = decideEscalation(CONTROL, 'day', [], null, after(h(2)));
    expect(r?.hoursOverdue).toBeCloseTo(2, 1);
  });
});
