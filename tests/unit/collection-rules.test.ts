import { describe, it, expect } from 'vitest';
import { collectionRuleToFilters } from '@/lib/collections/resolve';

const base = {
  rule_kind: null as 'place' | 'route' | null,
  rule_location_type: null as string | null,
  rule_activity_type: null as string | null,
  rule_difficulty: null as string | null,
  rule_query: null as string | null,
  rule_limit: null as number | null,
};

describe('collectionRuleToFilters — правило подборки → фильтры каталога', () => {
  it('без rule_kind → null (ручная подборка)', () => {
    expect(collectionRuleToFilters(base)).toBeNull();
    expect(collectionRuleToFilters({ ...base, rule_location_type: 'volcano' })).toBeNull();
  });

  it('place + location_type', () => {
    const f = collectionRuleToFilters({ ...base, rule_kind: 'place', rule_location_type: 'volcano' });
    expect(f).toMatchObject({ kind: 'place', location_type: 'volcano', page: 1, sort: 'title' });
    expect(f!.limit).toBeGreaterThan(0);
  });

  it('route + difficulty easy', () => {
    const f = collectionRuleToFilters({ ...base, rule_kind: 'route', rule_difficulty: 'easy' });
    expect(f).toMatchObject({ kind: 'route', difficulty: 'easy' });
  });

  it('недопустимая difficulty каталога отбрасывается (не easy/medium/hard)', () => {
    const f = collectionRuleToFilters({ ...base, rule_kind: 'route', rule_difficulty: 'extreme' });
    expect(f).toBeTruthy();
    expect(f!.difficulty).toBeUndefined();
  });

  it('rule_limit зажимается в [1, 200]', () => {
    expect(collectionRuleToFilters({ ...base, rule_kind: 'place', rule_limit: 9999 })!.limit).toBe(200);
    expect(collectionRuleToFilters({ ...base, rule_kind: 'place', rule_limit: 0 })!.limit).toBe(1);
    expect(collectionRuleToFilters({ ...base, rule_kind: 'place', rule_limit: null })!.limit).toBe(60);
  });

  it('activity_type и query прокидываются', () => {
    const f = collectionRuleToFilters({ ...base, rule_kind: 'route', rule_activity_type: 'eco', rule_query: 'озеро' });
    expect(f).toMatchObject({ activity_type: 'eco', q: 'озеро' });
  });
});
