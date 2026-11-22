/**
 * Голосование группы по дням сохранённой поездки (фича 6, слово владельца
 * 23.11 03:42: голос по ссылке без входа; итог предлагает заменить день
 * одной кнопкой, заменяет только владелец поездки).
 *
 * Персданных нет: ссылка — случайный токен, в БД только его sha256; голосующий
 * — случайный id в httpOnly-cookie, в БД только sha256(id ссылки + id). Ни
 * телефонов, ни почт, ни IP. Защита от накрутки — срок, потолок голосующих на
 * ссылку, лимит частоты по IP в памяти процесса. От решительного человека с
 * сотней браузеров она не спасает — так и сказано владельцу на экране.
 *
 * Сторож: tests/unit/trip-vote.test.ts.
 */
import { createHash, randomBytes } from 'node:crypto';

export const VOTE_MIN_HOURS = 24;
export const VOTE_MAX_HOURS = 168;
/** Сколько разных голосующих принимает одна ссылка. */
export const MAX_VOTERS = 30;
export const VOTER_COOKIE = 'trip_voter';

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const VOTER_RE = /^[0-9a-f]{32}$/;

export function newVoteToken(): string {
  return randomBytes(24).toString('base64url');
}
export function newVoterId(): string {
  return randomBytes(16).toString('hex');
}
export function hashToken(token: string): string {
  return createHash('sha256').update(`trip-vote:${token}`).digest('hex');
}
export function voterKey(linkId: string, voterId: string): string {
  return createHash('sha256').update(`trip-voter:${linkId}:${voterId}`).digest('hex');
}

export { tallyVotes, groupAgainst, tallyWords, type DayTally } from './trip-vote-words';

/** Срок голосования из часов владельца — в пределах 24 ч…7 дней. */
export function voteDeadline(now: Date, hours: number): Date {
  const h = Math.min(VOTE_MAX_HOURS, Math.max(VOTE_MIN_HOURS, Math.round(hours)));
  return new Date(now.getTime() + h * 3_600_000);
}
