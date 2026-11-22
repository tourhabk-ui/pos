/**
 * Итог голосования группы словами (фича 6) — без node:crypto, годится и
 * для браузера. Сторож: tests/unit/trip-vote.test.ts.
 */
export interface DayTally { day: number; up: number; down: number }

/** Строки голосов → итог по дням (только дни 1…maxDay). */
export function tallyVotes(rows: ReadonlyArray<{ day_num: number; vote: number }>, maxDay: number): DayTally[] {
  const by = new Map<number, DayTally>();
  for (const r of rows) {
    const day = Number(r.day_num);
    if (!Number.isInteger(day) || day < 1 || day > maxDay) continue;
    const t = by.get(day) ?? { day, up: 0, down: 0 };
    if (Number(r.vote) > 0) t.up += 1; else if (Number(r.vote) < 0) t.down += 1;
    by.set(day, t);
  }
  return [...by.values()].sort((a, b) => a.day - b.day);
}

/** Группа против дня: «против» больше, чем «за». Ничья — не повод менять. */
export function groupAgainst(t: DayTally): boolean {
  return t.down > t.up;
}

/** «3 из 4 за» / «2 из 3 против» — словами, без процентов. */
export function tallyWords(t: DayTally): string {
  const total = t.up + t.down;
  if (total === 0) return 'голосов нет';
  if (t.up === t.down) return `поровну: ${t.up} за, ${t.down} против`;
  return t.up > t.down ? `${t.up} из ${total} за` : `${t.down} из ${total} против`;
}
