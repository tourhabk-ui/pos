/**
 * Опасные советы, которые не уходят туристу ни на одной поверхности.
 * Проверка перед отправкой: предложение с таким советом вырезается,
 * а в конец ответа ставится проверенный номер 112.
 *
 * Экзамен 22.10.2026 (#26) и eval-kuzmich 19.10 (bear-encounter): Кузьмич
 * советовал при нападении медведя «притворись мёртвым». Тот же запрет есть
 * в lib/kuzmich/safety-eval.ts (GOLDEN_CASES), здесь он применяется к живому
 * ответу. Отрицание («не притворяйся мёртвым») не вырезается.
 *
 * Второй запрет — выдуманная оценка безопасности способа или тура (ночной
 * эвал 17.11, commercial-op-mestechko-tolbachik): «вертолётный облёт — это
 * пока единственный безопасный способ увидеть Толбачик». Такой оценки нет ни
 * в одной сводке и ни в одной строке тура: сравнивать туры по безопасности
 * Ведару не по чему, а человек выберет по ней. Предложение вырезается без
 * строки взамен — остальной ответ (закрытый парк, опасность) остаётся.
 * Отрицание («не самый безопасный способ») — предупреждение, оно остаётся.
 */
const PLAY_DEAD = /(?<!не\s)притвор(?:ись|итесь|иться|яйся|яйтесь|яться)\s+(?:м[её]ртв|трупом)/iu;

/**
 * «Единственный / самый / наиболее безопасный способ (вариант, тур, маршрут…)».
 * Граница слова — руками: JS \b кириллицу не знает.
 */
const SAFETY_RANKING_RE = /(?<![а-яё])(?<!не\s)(?:единственн|сам|наиболее)[а-яё]*\s+безопасн[а-яё]*\s+(?:способ|вариант|путь|тур|маршрут|выбор|решени|возможност)[а-яё]*(?![а-яё])/giu;

/**
 * Осторожный совет — не оценка тура: «самый безопасный вариант — отложить
 * поход», «… — остаться в укрытии и звонить 112». Он защищает, и он остаётся.
 */
const CAUTION_AFTER = /^[^.!?\n]{0,60}(?:отлож|остат|остан|не\s+(?:выход|ход|ехат|езди|подним)|дожд|вернут|переждат|подожд|перенест|укрыт|112)/iu;

/** Есть ли в тексте выдуманная оценка безопасности способа или тура (не осторожный совет). */
export function hasSafetyRanking(text: string): boolean {
  for (const m of text.matchAll(SAFETY_RANKING_RE)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (!CAUTION_AFTER.test(after)) return true;
  }
  return false;
}

export const BANNED_ADVICE_NOTE = 'При нападении зверя звони 112: это работает без баланса и SIM.';

export interface BannedAdviceResult {
  text: string;
  /** Вырезанный совет «притворись мёртвым» — к ответу дописан 112. */
  removed: string[];
  /** Вырезанная выдуманная оценка безопасности способа или тура. */
  ranking: string[];
}

function cut(answer: string, banned: (sentence: string) => boolean, into: string[]): string {
  return answer
    .split('\n')
    .map((line) => line
      .split(/(?<=[.!?…])\s+/u)
      .filter((s) => {
        if (banned(s)) { into.push(s); return false; }
        return true;
      })
      .join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripBannedAdvice(answer: string): BannedAdviceResult {
  const hasPlayDead = PLAY_DEAD.test(answer);
  const hasRanking = hasSafetyRanking(answer);
  if (!hasPlayDead && !hasRanking) return { text: answer, removed: [], ranking: [] };
  const removed: string[] = [];
  const ranking: string[] = [];
  // Режем по предложениям, сохраняя абзацы.
  let text = hasPlayDead ? cut(answer, (x) => PLAY_DEAD.test(x), removed) : answer;
  if (hasRanking) text = cut(text, hasSafetyRanking, ranking);
  return { text: removed.length > 0 ? `${text}\n\n${BANNED_ADVICE_NOTE}` : text, removed, ranking };
}
