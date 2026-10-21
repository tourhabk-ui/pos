/**
 * Опасные советы, которые не уходят туристу ни на одной поверхности.
 * Проверка перед отправкой: предложение с таким советом вырезается,
 * а в конец ответа ставится проверенный номер 112.
 *
 * Экзамен 22.10.2026 (#26) и eval-kuzmich 19.10 (bear-encounter): Кузьмич
 * советовал при нападении медведя «притворись мёртвым». Тот же запрет есть
 * в lib/kuzmich/safety-eval.ts (GOLDEN_CASES), здесь он применяется к живому
 * ответу. Отрицание («не притворяйся мёртвым») не вырезается.
 */
const PLAY_DEAD = /(?<!не\s)притвор(?:ись|итесь|иться|яйся|яйтесь|яться)\s+(?:м[её]ртв|трупом)/iu;

export const BANNED_ADVICE_NOTE = 'При нападении зверя звони 112: это работает без баланса и SIM.';

export interface BannedAdviceResult { text: string; removed: string[] }

export function stripBannedAdvice(answer: string): BannedAdviceResult {
  if (!PLAY_DEAD.test(answer)) return { text: answer, removed: [] };
  const removed: string[] = [];
  // Режем по предложениям, сохраняя абзацы.
  const text = answer
    .split('\n')
    .map((line) => line
      .split(/(?<=[.!?…])\s+/u)
      .filter((s) => {
        if (PLAY_DEAD.test(s)) { removed.push(s); return false; }
        return true;
      })
      .join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: `${text}\n\n${BANNED_ADVICE_NOTE}`, removed };
}
