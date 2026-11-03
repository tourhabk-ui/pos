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

/** Строка вместо вырезанного километража; она же — поправка к уже отданному стриму. */
export const DISTANCE_HONEST_LINE =
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
  const km = stripUngroundedKmClaims(answer, context);
  const time = stripUngroundedTravelTimeClaims(km.cleaned, context);
  return { cleaned: time.cleaned, removed: [...km.removed, ...time.removed] };
}

function stripUngroundedKmClaims(answer: string, context: string): DistanceGuardResult {
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
          kept.push(DISTANCE_HONEST_LINE);
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

// ── Время в пути (решение владельца 03.11, эвал logistics-2/3) ────────────
//
// «около 1–1,5 часа лёта из Елизово», «2–3 дня пути на внедорожнике»,
// «3–3,5 часа на машине» — модель называла по памяти, в контексте этих чисел
// не было. Ловится утверждение «число + час/мин/день» рядом со словом дороги
// (лёт, езда, путь, дорога, на машине/вертолёте/внедорожнике…), число
// которого не стоит в контексте при единице времени. Длительность тура
// («тур на 4 дня», строка каталога «- «…» — …₽») и время на маршруте
// пешком (подъём 12,5 ч — из БД) не трогаются: у них нет слова дороги или
// они заземлены.

/** Вместо вырезанного времени в пути. */
export const TRAVEL_TIME_HONEST_LINE =
  'Точного времени дороги в моих данных нет — время в пути подтвердит оператор или перевозчик.';

const NUM = String.raw`\d{1,3}(?:[.,]\d+)?`;
const UNIT = String.raw`(?:час[а-яё]*|ч(?![а-яё])|минут[а-яё]*|мин(?![а-яё])|дн(?:я|ей|\.)?(?![а-яё])|день(?![а-яё])|сут(?:ок|ки)?(?![а-яё]))`;
const TIME_CLAIM_RE = new RegExp(`(${NUM})(?:\\s*[–—-]\\s*(${NUM}))?\\s*${UNIT}`, 'gi');
const TRAVEL_CUE_RE = /л[её]т[аау]?(?![а-яё])|пол[её]т|перел[её]т|езд[ыаеу]|ехать|едут|доезд|в пути|пути(?![а-яё])|дорог[аиуеой]|на машине|на автомобил|на внедорожник|на вездеход|на автобус|вертол[её]т|трансфер/i;
const HIKE_RE = /подъ[её]м|восхожд|спуск|пешк|пеш[иа]|треккинг|трек(?![а-яё])|радиальн|сплав/i;
const TOUR_DURATION_RE = /тур[а-яё]*\s+(?:на\s+)?\d|продолжительн|программ[а-яё]*\s+на/i;

function timeGrounded(n: string, context: string): boolean {
  const esc = escapeForRegex(n);
  const re = new RegExp(`(?<![\\d.,])${esc}(?![\\d]|[.,]\\d)(?:\\s*[–—-]\\s*${NUM})?\\s*${UNIT}|${NUM}\\s*[–—-]\\s*${esc}(?![\\d]|[.,]\\d)\\s*${UNIT}`, 'i');
  return re.test(context);
}

function isUngroundedTravelTime(sentence: string, context: string): boolean {
  if (!TRAVEL_CUE_RE.test(sentence)) return false;
  for (const m of sentence.matchAll(TIME_CLAIM_RE)) {
    const around = sentence.slice(Math.max(0, m.index! - 25), m.index! + m[0].length + 30);
    if (!TRAVEL_CUE_RE.test(around) || HIKE_RE.test(around)) continue;
    if (TOUR_DURATION_RE.test(sentence.slice(Math.max(0, m.index! - 20), m.index! + m[0].length))) continue;
    const nums = [m[1]!, m[2]].filter(Boolean) as string[];
    if (nums.some((n) => !timeGrounded(n, context))) return true;
  }
  return false;
}

/** Вырезает предложения/пункты с незаземлённым временем в пути. Строки
 *  каталога туров («- «Тур» — Оператор, от N ₽») не трогаются. */
export function stripUngroundedTravelTimeClaims(answer: string, context: string): DistanceGuardResult {
  const removed: string[] = [];
  const paragraphs = answer.split(/\n\s*\n/).map((para) => {
    let inserted = false;
    const lines = para.split('\n').map((line) => {
      if (/^\s*[-•]\s*«/.test(line) || /₽/.test(line)) return line;
      const bullet = line.match(/^\s*(?:[-•*]|\d+[.)])\s+/)?.[0] ?? '';
      const sentences = splitSentences(line.slice(bullet.length));
      const kept = sentences.filter((s) => {
        if (!isUngroundedTravelTime(s, context)) return true;
        removed.push(s);
        return false;
      });
      if (kept.length === sentences.length) return line;
      const honest = inserted ? '' : TRAVEL_TIME_HONEST_LINE;
      inserted = true;
      const body = [...kept, honest].filter(Boolean).join(' ');
      return body ? `${bullet}${body}` : null;
    });
    return lines.filter((l): l is string => l !== null).join('\n');
  });
  if (removed.length === 0) return { cleaned: answer, removed: [] };
  return { cleaned: paragraphs.join('\n\n'), removed };
}
