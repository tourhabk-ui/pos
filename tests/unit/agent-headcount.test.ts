import { describe, it, expect } from 'vitest';
import { normalizeToolHeadcount, pickHeadcount } from '@/lib/agent/headcount';

describe('headcount aliases', () => {
  for (const k of ['participants_count', 'participants', 'guests', 'passengers', 'guest_count']) {
    it(`tour accepts ${k}`, () => {
      expect(normalizeToolHeadcount('create_booking_request', { [k]: 5 })).toEqual({ participants: 5 });
    });
  }
  it('stay canonical is guests', () => {
    expect(normalizeToolHeadcount('create_stay_request', { participants: 3 })).toEqual({ guests: 3 });
  });
  it('charter canonical is passengers', () => {
    expect(normalizeToolHeadcount('request_charter', { guests: '4' })).toMatchObject({ passengers: '4' });
  });
  it('pick returns undefined when none', () => { expect(pickHeadcount({})).toBeUndefined(); });
});
