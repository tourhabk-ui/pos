/** Голосование группы (фича 6): итог словами, срок, хэши без персданных. */
import { describe, it, expect } from 'vitest';
import { tallyVotes, groupAgainst, tallyWords, voteDeadline, hashToken, voterKey, newVoteToken, newVoterId, TOKEN_RE, VOTER_RE } from '@/lib/trips/trip-vote';

describe('trip-vote', () => {
  it('итог по дням; чужие номера дней отброшены', () => {
    const t = tallyVotes([{ day_num: 2, vote: 1 }, { day_num: 2, vote: -1 }, { day_num: 2, vote: -1 }, { day_num: 9, vote: 1 }], 5);
    expect(t).toEqual([{ day: 2, up: 1, down: 2 }]);
    expect(groupAgainst(t[0])).toBe(true);
    expect(tallyWords(t[0])).toBe('2 из 3 против');
  });
  it('ничья — не «против»', () => {
    expect(groupAgainst({ day: 1, up: 1, down: 1 })).toBe(false);
    expect(tallyWords({ day: 1, up: 1, down: 1 })).toBe('поровну: 1 за, 1 против');
    expect(tallyWords({ day: 1, up: 3, down: 1 })).toBe('3 из 4 за');
  });
  it('срок — от суток до недели', () => {
    const now = new Date('2026-11-23T00:00:00Z');
    expect(voteDeadline(now, 1).toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(voteDeadline(now, 1000).toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });
  it('токен и id голосующего — случайные, в БД только хэш', () => {
    const t = newVoteToken();
    expect(t).toMatch(TOKEN_RE);
    expect(newVoterId()).toMatch(VOTER_RE);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(voterKey('a', 'b')).not.toBe(voterKey('a', 'c'));
  });
});
