/**
 * lib/kuzmich/distance-guard.ts
 *
 * Детерминированный guard на придуманный километраж «от Петропавловска» (#1883).
 *
 * Системный промпт (core.ts, блок «ГЕОГРАФИЯ И ЛОГИСТИКА МЕСТ/МАРШРУТОВ»)
 * прямо запрещает называть расстояния не из данных платформы, «даже уверенно
 * и по жизни» — и это не помогает. Разбор двух прогонов евала подряд (13.09
 * pass_rate 0.60, 14.09 pass_rate 0.75) показал ОДИН И ТОТ ЖЕ провал три раза:
 * «от Петропавловска-Камчатского до Паратунки примерно 60 километров»,
 * «Малкинские источники — примерно 200 км от Петропавловска-Камчатского»,
 * «от Петропавловска-Камчатского до Курильского озера около 400 км» — ни
 * одного из этих чисел в retrieved-контексте не было. Разрастающийся список
 * запретов в промпте не работает (§8: «признак того, что нужен инструмент
 * или серверный guard») — здесь тот же приём, что у lib/safety/sos-detector.ts:
 * не просим модель вести себя лучше, а детерминированно ловим нарушение и
 * правим текст сами, до того как турист его увидит.
 *
 * ── Что ловится ──────────────────────────────────────────────────────────
 *
 * Предложение с «N км»/«N километров» РЯДОМ с упоминанием Петропавловска/
 * города/ПК, число которого не встречается в собранном контексте (тот же
 * набор блоков, которым обоснован ответ — toolContext + dynamic + tourContext,
 * ровно то, что видит судья faithfulness в askKuzmichForEval). Следом
 * прихватывается и следующее предложение, если оно похоже на продолжение
 * («дорога идёт через Елизово», «час на машине») — этот паттерн шёл в паре
 * с числом во всех трёх живых случаях.
 *
 * Маршрутная «дистанция N км» (routeFacts(), lib/ai/route-knowledge.ts) под
 * эту проверку не попадает и не должна: она заземлена в БД (§10), и рядом с
 * ней нет слова «Петропавловск»/«города» — это длина трека, а не путь от
 * города до него, разные факты.
 *
 * ── Что НЕ ловится (осознанно, не по недосмотру) ────────────────────────
 *
 * То же число, повторённое в другом предложении без города рядом («не
 * "400 км за 4 часа"»); маршрутное время без числа км. Резать шире значило
 * бы гадать за пределами того, что реально воспроизведено — три
 * задокументированных провала, не гипотетический класс «вся география».
 *
 * Чистый модуль без сети/БД — применяется и в aiChat (живой ответ), и в
 * askKuzmichForEval (евал), чтобы цифра pass_rate отражала то, что видит
 * турист, а не то, что видел бы без guard'а.
 */

// `\b` после кириллицы не работает: JS `\w` = [A-Za-z0-9_], кириллицу за
// слово не считает, и граница между «м» и пробелом не находится (урок этого
// репозитория, повторён трижды в lib/services/safety/seismic-parser.ts —
// и чуть не повторён здесь же в первой редакции: `км\b`/`города\b` не
// матчились НИ РАЗУ). Отсюда `(?![а-яё])` вместо `\b` после кириллических
// концовок; перед цифрой `\b` оставлен — цифры ASCII, граница там работает.
const KM_CLAIM_RE = /(\d{1,4}(?:[.,]\d+)?)\s*(?:км(?![а-яё])|километр[а-яё]*)/gi;
const CITY_REF_RE = /петропавловск|от\s+города(?![а-яё])|от\s+пк(?![а-яё])/i;
// Продолжение claim'а: способ добраться, а не новая самостоятельная тема.
const ROUTE_ELABORATION_RE = /час[а-яё]*\s+на\s+машине|минут[а-яё]*\s+на\s+машине|на\s+машине(?![а-яё])|через\s+[А-ЯЁ][а-яё]+|грунтов[а-яё]*/i;

const HONEST_FALLBACK =
  'Точных данных о расстоянии и дороге сюда у меня нет — уточни у оператора или посмотри на карте.';

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isGroundedInContext(km: string, context: string): boolean {
  if (!context) return false;
  const re = new RegExp(`\\b${escapeForRegex(km)}\\s*(?:км(?![а-яё])|километр)`, 'i');
  return re.test(context);
}

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

export interface DistanceGuardResult {
  cleaned: string;
  /** Вырезанные предложения — для лога/теста, не для показа туристу. */
  removed: string[];
}

/**
 * Вырезает предложения с незаземлённым километражом «от города», сохраняя
 * структуру абзацев (split/join по пустой строке, а не построчно) — иначе
 * многоабзацный ответ схлопнулся бы в одну простыню.
 */
export function stripUngroundedDistanceClaims(answer: string, context: string): DistanceGuardResult {
  const paragraphs = answer.split(/\n\s*\n/);
  const removed: string[] = [];

  const outParagraphs = paragraphs.map((para) => {
    const sentences = splitSentences(para);
    if (sentences.length === 0) return para;

    const flagged = new Set<number>();
    for (let i = 0; i < sentences.length; i++) {
      if (flagged.has(i)) continue;
      const s = sentences[i]!;
      if (!CITY_REF_RE.test(s)) continue;

      const nums = [...s.matchAll(KM_CLAIM_RE)].map((m) => m[1]!);
      if (nums.length === 0) continue;

      const anyUngrounded = nums.some((km) => !isGroundedInContext(km, context));
      if (!anyUngrounded) continue; // все числа этого предложения подтверждены контекстом

      flagged.add(i);
      removed.push(s);

      const next = sentences[i + 1];
      if (next !== undefined && ROUTE_ELABORATION_RE.test(next)) {
        flagged.add(i + 1);
        removed.push(next);
      }
    }

    if (flagged.size === 0) return para;

    const kept: string[] = [];
    let inserted = false;
    for (let i = 0; i < sentences.length; i++) {
      if (flagged.has(i)) {
        if (!inserted) {
          kept.push(HONEST_FALLBACK);
          inserted = true;
        }
        continue;
      }
      kept.push(sentences[i]!);
    }
    return kept.join(' ');
  });

  if (removed.length === 0) return { cleaned: answer, removed: [] };
  return { cleaned: outParagraphs.join('\n\n'), removed };
}
