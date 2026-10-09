/**
 * Сторож группового планирования (#2226, решение владельца 08.10).
 *
 * - наружу уходит только сводка: строк участников не отдаёт ни API, ни
 *   страница (флаги участника — его дело, а ссылку группы видит любой, у
 *   кого она есть) — это «trip-groups-no-member-rows»;
 * - пожелания без согласия не принимаются, и согласие доходит до базы;
 * - план группы собирает тот же движок с ограничениями группы, а правка
 *   плана потом их не теряет;
 * - даты — в тех же границах, что у планера.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { query, recommend, save } = vi.hoisted(() => ({ query: vi.fn(), recommend: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/planner/engine', () => ({ recommendTrip: (...a: unknown[]) => recommend(...a) }));
vi.mock('@/lib/planner/plan-drafts', () => ({
  isDraftId: (s: string) => /^[0-9a-f-]{36}$/i.test(s),
  saveDraft: (...a: unknown[]) => save(...a),
}));

import * as groups from '@/lib/planner/trip-groups';
import { groupSummary, addMember, buildGroupPlan, groupDatesProblem } from '@/lib/planner/trip-groups';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const GID = '11111111-2222-3333-4444-555555555555';
const MEMBERS = [
  { interests: ['bears', 'volcano'], fitness: 'active', no_hard_climbs: false, seasickness: false, limited_mobility: false, youngest_child: null, budget: 'premium' },
  { interests: ['bears'], fitness: 'beginner', no_hard_climbs: true, seasickness: true, limited_mobility: true, youngest_child: 7, budget: 'economy' },
];

function db(members = MEMBERS) {
  query.mockImplementation(async (sql: string) => {
    if (/FROM trip_groups WHERE id/.test(sql)) {
      return { rows: [{ id: GID, arrival_date: '2027-07-10', departure_date: '2027-07-16', expires_at: '2027-07-01T00:00:00Z' }] };
    }
    if (/FROM trip_group_members/.test(sql)) return { rows: members };
    return { rows: [] };
  });
}

beforeEach(() => { query.mockReset(); recommend.mockReset(); save.mockReset(); });

describe('наружу — только сводка', () => {
  it('сводка несёт число участников и агрегат, но не строки участников', async () => {
    db();
    const r = await groupSummary(GID);
    if (r.kind !== 'found') throw new Error(r.kind);
    expect(r.summary.members).toBe(2);
    expect(Object.keys(r.summary).sort()).toEqual(['arrivalDate', 'departureDate', 'expiresAt', 'id', 'maxMembers', 'members', 'profile']);
    const json = JSON.stringify(r.summary);
    // Никаких полей строки участника: ни флагов поштучно, ни возраста кроме сведённого.
    expect(json).not.toMatch(/no_hard_climbs|noHardClimbs|limited_mobility|youngest_child|youngestChild/);
  });

  it('чтение со строками участников наружу не экспортируется', () => {
    expect('loadGroup' in groups).toBe(false);
    const route = read('app/api/trip-groups/[id]/route.ts');
    expect(route).toMatch(/groupSummary\(id\)/);
    expect(route).not.toMatch(/trip_group_members/);
  });

  it('три исхода чтения: нет группы ≠ не смогли прочитать', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await groupSummary(GID)).kind).toBe('missing');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await groupSummary(GID)).kind).toBe('failed');
    expect((await groupSummary('не-uuid')).kind).toBe('missing');
    spy.mockRestore();
  });
});

describe('согласие и потолок', () => {
  it('роут пожеланий требует согласие и пишет его', () => {
    const route = read('app/api/trip-groups/[id]/members/route.ts');
    expect(route).toMatch(/pd_consent:\s+z\.literal\(true/);
    expect(route).toMatch(/buildConsentRecord\(d\.pd_consent, ip, 'trip-group'\)/);
    expect(read('migrations/1184_trip_groups.sql')).toMatch(/pd_consent_at\s+TIMESTAMPTZ NOT NULL/);
  });

  it('свободного текста о здоровье нет ни в таблице, ни в роуте', () => {
    expect(read('migrations/1184_trip_groups.sql')).not.toMatch(/health|diagnos|диагноз\s+TEXT|notes\s+TEXT/i);
    expect(read('app/api/trip-groups/[id]/members/route.ts')).not.toMatch(/health|notes|comment/i);
  });

  it('запись идёт с потолком в том же запросе; полная группа — «full», а не «нет группы»', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO trip_group_members/.test(sql)) {
        expect(sql).toMatch(/COUNT\(\*\) FROM trip_group_members m WHERE m\.group_id = g\.id\) < \$13::int/);
        return { rows: [] };
      }
      if (/FROM trip_groups WHERE id/.test(sql)) return { rows: [{ id: GID, arrival_date: '2027-07-10', departure_date: '2027-07-16', expires_at: '2027-07-01' }] };
      return { rows: [] };
    });
    const consent = { at: new Date(), ip: '1.1.1.1', source: 'trip-group', version: 'v' };
    const w = { interests: ['bears'], fitness: 'moderate' as const, noHardClimbs: false, seasickness: false, limitedMobility: false, youngestChild: null, budget: 'comfort' as const };
    expect(await addMember(GID, w, consent)).toBe('full');
  });
});

describe('план группы', () => {
  it('движок получает ограничения группы, черновик — их же для правки', async () => {
    db();
    recommend.mockResolvedValue({ days: [{ day: 1 }] });
    save.mockResolvedValue('99999999-2222-3333-4444-555555555555');
    const r = await buildGroupPlan(GID);
    expect(r).toEqual({ kind: 'planned', draftId: '99999999-2222-3333-4444-555555555555' });
    const profile = recommend.mock.calls[0][0];
    expect(profile).toMatchObject({
      interests: ['bears'], fitnessLevel: 'beginner', budgetTier: 'economy', adults: 2, children: [7],
      seasickness: true, mobilityLevel: 'limited', riskMode: 'safe_only',
    });
    const [plan, surface] = save.mock.calls[0];
    expect(surface).toBe('group');
    expect(plan.params).toMatchObject({ fitnessLevel: 'beginner', seasickness: true, mobilityLevel: 'limited' });
  });

  it('пустая группа — «empty», а не план по умолчанию', async () => {
    db([]);
    expect(await buildGroupPlan(GID)).toEqual({ kind: 'empty' });
    expect(recommend).not.toHaveBeenCalled();
  });
});

describe('даты группы', () => {
  it('3–21 день, не в прошлом', () => {
    expect(groupDatesProblem('2027-07-10', '2027-07-16', '2026-10-08')).toBeNull();
    expect(groupDatesProblem('2027-07-10', '2027-07-11', '2026-10-08')).toMatch(/от 3 до 21/);
    expect(groupDatesProblem('2026-10-01', '2026-10-07', '2026-10-08')).toMatch(/прошла/);
  });
});
