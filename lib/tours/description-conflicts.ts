/**
 * Описание тура спорит с записью тура о размере группы (#3487, 17.11).
 *
 * Повод. Текст описания пишет оператор, а число группы лежит в колонках
 * `min_participants` / `max_participants`. Это два источника одного факта, и
 * они расходятся: в описании «группа от 4 человек», а в записи минимум 1 или
 * не записан вовсе. Карточка показывает и то и другое, MCP пересказывает
 * описание, и человек читает два ответа на один вопрос.
 *
 * Править текст оператора здесь нельзя — это его слова, и что из двух верно,
 * знает только он. Функция называет расхождение, а решает вызывающий: MCP
 * говорит агенту, что число уточняется у оператора, сторож
 * `tests/unit/tour-surfaces-agree.test.tsx` держит само правило.
 *
 * Что считается утверждением о группе — только оборот со словом «человек»
 * (или «чел.», «участник», «турист») рядом с числом: «группа от 4 человек»,
 * «до 8 человек», «от 2 до 6 участников». Голое «от 4» — не о группе (цена,
 * километры, часы), его не трогаем.
 */

export interface GroupClaimConflict {
  /** Оборот из текста как есть. */
  phrase: string;
  /** О чём оборот: минимум («от N») или предел («до N»). */
  bound: 'min' | 'max';
  /** Число в тексте. */
  said: number;
  /** Число в записи тура; не записано — null. */
  recorded: number | null;
}

const PEOPLE = '(?:человек[а]?|чел\\.?|участник(?:а|ов)?|турист(?:а|ов)?)';
/** «от 2 до 6 человек» — сначала полный диапазон, чтобы «до 6» не читалось отдельно. */
const RANGE = new RegExp(`(?:групп[аеуы]\\s+)?от\\s+(\\d{1,3})\\s+до\\s+(\\d{1,3})\\s+${PEOPLE}`, 'gi');
const BOUND = new RegExp(`(?:групп[аеуы]\\s+)?(от|до)\\s+(\\d{1,3})(?:-?х|-?ти|-?ми)?\\s+${PEOPLE}`, 'gi');

function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Обороты о размере группы в тексте, которые не совпадают с записью тура.
 * Запись не сделана (null), а текст число называет, — тоже расхождение:
 * у карточки и у MCP числа нет, а в описании есть.
 */
export function groupClaimConflicts(
  text: string | null | undefined,
  minParticipants: unknown,
  maxParticipants: unknown,
): GroupClaimConflict[] {
  if (!text) return [];
  const min = positive(minParticipants);
  const max = positive(maxParticipants);
  const out: GroupClaimConflict[] = [];
  const check = (phrase: string, bound: 'min' | 'max', said: number) => {
    const recorded = bound === 'min' ? min : max;
    if (recorded !== said) out.push({ phrase, bound, said, recorded });
  };
  let rest = text;
  for (const m of text.matchAll(RANGE)) {
    check(m[0], 'min', Number(m[1]));
    check(m[0], 'max', Number(m[2]));
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(BOUND)) {
    check(m[0], m[1].toLowerCase() === 'от' ? 'min' : 'max', Number(m[2]));
  }
  return out;
}

/** Одна строка агенту о расхождении; расхождений нет — null. */
export function groupClaimConflictLine(conflicts: readonly GroupClaimConflict[]): string | null {
  if (conflicts.length === 0) return null;
  const parts = conflicts.map((c) => {
    const rec = c.recorded === null ? 'в записи тура числа нет' : `в записи тура ${c.bound === 'min' ? 'минимум' : 'предел'} ${c.recorded}`;
    return `в описании «${c.phrase.trim()}», а ${rec}`;
  });
  return `Размер группы расходится: ${parts.join('; ')}. Какое число верно, знает оператор — не называй его как факт.`;
}
