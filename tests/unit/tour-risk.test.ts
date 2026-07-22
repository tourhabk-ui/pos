import { describe, it, expect } from 'vitest';
import { isHighRiskTour, highRiskReason } from '@/lib/safety/tour-risk';
import { normalizeBookingId } from '@/lib/bookings/booking-id';

describe('isHighRiskTour — высокорисковые туры требуют вейвер', () => {
  it('сложность hard/difficult/extreme/expert → высокий риск', () => {
    for (const d of ['hard', 'difficult', 'extreme', 'expert']) {
      expect(isHighRiskTour(d, 'trekking'), d).toBe(true);
    }
  });

  it('лёгкие/средние → не требуют вейвер (если активность не опасна)', () => {
    for (const d of ['easy', 'medium', 'moderate']) {
      expect(isHighRiskTour(d, 'eco'), d).toBe(false);
    }
  });

  it('опасная активность → высокий риск даже при лёгкой сложности', () => {
    for (const a of ['volcano', 'helicopter', 'rafting', 'winter_hiking', 'mountaineering']) {
      expect(isHighRiskTour('easy', a), a).toBe(true);
    }
  });

  it('регистр и пробелы не важны', () => {
    expect(isHighRiskTour(' Extreme ', null)).toBe(true);
    expect(isHighRiskTour(null, ' Volcano ')).toBe(true);
  });

  it('null/пусто → не высокий риск (нет данных — не выдумываем)', () => {
    expect(isHighRiskTour(null, null)).toBe(false);
    expect(isHighRiskTour('', '')).toBe(false);
    expect(isHighRiskTour(undefined, undefined)).toBe(false);
  });
});

describe('highRiskReason — человекочитаемая причина', () => {
  it('активность важнее сложности (конкретнее)', () => {
    expect(highRiskReason('hard', 'volcano')).toBe('восхождение на вулкан');
    expect(highRiskReason('easy', 'rafting')).toBe('сплав по реке');
  });
  it('только сложность → общая причина', () => {
    expect(highRiskReason('extreme', 'trekking')).toBe('высокая сложность маршрута');
  });
  it('не высокорисковый → null', () => {
    expect(highRiskReason('easy', 'eco')).toBeNull();
    expect(highRiskReason(null, null)).toBeNull();
  });
});

describe('normalizeBookingId — bigint id, снимает префикс op-', () => {
  it('снимает op- и оставляет bigint', () => {
    expect(normalizeBookingId('op-42')).toBe('42');
    expect(normalizeBookingId('42')).toBe('42');
  });
  it('отвергает не-bigint', () => {
    expect(normalizeBookingId('op-abc')).toBeNull();
    expect(normalizeBookingId('1dd78671-3818-4309')).toBeNull();
    expect(normalizeBookingId('12; DROP TABLE')).toBeNull();
    expect(normalizeBookingId('')).toBeNull();
    expect(normalizeBookingId(null)).toBeNull();
    expect(normalizeBookingId(undefined)).toBeNull();
  });
});
