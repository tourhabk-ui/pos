/**
 * Строка внешней тревоги в контексте места — по тому, ГДЕ в ней названо место.
 *
 * Контекст места (`getGuardianContext`) берёт из `external_alerts` тревоги,
 * в заголовке или описании которых встречается название. Описание у сводки
 * МЧС из соцсетей — это вся сводка: дорога в одном округе, пожары мусора в
 * другом, вулкан в третьем. До 22.10 строка печатала заголовок тревоги и
 * первые 150 знаков описания, и у Шивелуча стояло «Остаётся закрытым проезд
 * … в Усть-Большерецком округе: За прошедшие сутки … горел мусор … Погибш…»
 * (дайджест 22.10, #2699): чужой район, чужая тема и обрывок о погибших,
 * который читается как происшествие на вулкане. Шивелуч был назван где-то
 * дальше в той же сводке.
 *
 * Правило: место названо в заголовке или в первом пункте описания — тревога
 * о нём, печатаются заголовок и текст рядом с названием. Названо в одном из
 * следующих пунктов сводки — это упоминание в сводке о другом: печатается
 * предложение, где место названо, с пометкой «упоминание в сводке», а не чужой
 * заголовок. Обрезка — по границе слова и с многоточием, а не посреди слова.
 */

/** Сколько знаков текста тревоги уходит в строку контекста. */
export const ALERT_SNIPPET_MAX = 150;

export interface AlertMentionRow {
  title: string;
  description: string | null;
}

/** Нижний регистр и ё → е: так же широко, как ILIKE запроса, и чуть шире. */
function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Не длиннее `max`, конец — по границе слова и с «…». Если указан `at` —
 * позиция, которую нельзя потерять (названное место), — окно сдвигается к ней,
 * и спереди тоже ставится «…».
 */
export function clipAtWord(text: string, max: number = ALERT_SNIPPET_MAX, at?: { index: number; length: number }): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let start = 0;
  if (at && at.index + at.length > max - 1) {
    // Место дальше окна: окно начинается чуть раньше него, с начала слова.
    const from = Math.max(0, at.index - Math.floor(max / 3));
    const space = t.lastIndexOf(' ', from);
    start = space > 0 ? space + 1 : from;
  }
  // Многоточия входят в длину: одно в конце, ещё одно в начале, если окно сдвинуто.
  const end = Math.min(t.length, start + max - (start > 0 ? 2 : 1));
  let cutEnd = end;
  if (end < t.length && /\S/u.test(t[end]) && /\S/u.test(t[end - 1])) {
    // Окно режет слово — отступить к пробелу, но не раньше конца названия места.
    const space = t.lastIndexOf(' ', end);
    const keep = at ? at.index + at.length : start;
    if (space > start && space >= keep) cutEnd = space;
  }
  const body = t.slice(start, cutEnd).replace(/[\s,;:—-]+$/u, '');
  return `${start > 0 ? '…' : ''}${body}${cutEnd < t.length ? '…' : ''}`;
}

/** Пункты описания — строки без маркеров списка и эмодзи в начале (как `splitSummaryItems` ингеста). */
function descriptionItems(description: string): string[] {
  return description
    .split('\n')
    .map((l) => l.replace(/^[^\p{L}\p{N}]+/u, '').trim())
    .filter((l) => l.length > 0);
}

/** Предложение пункта, где названо место, и позиция названия в нём. */
function sentenceWith(item: string, needle: string): { text: string; index: number } {
  for (const s of item.split(/(?<=[.!?…])\s+/u)) {
    const index = norm(s).indexOf(needle);
    if (index >= 0) return { text: s, index };
  }
  return { text: item, index: norm(item).indexOf(needle) };
}

/**
 * Строка тревоги для контекста места или null — если название не нашлось ни в
 * заголовке, ни в описании (печатать нечего: связь с местом не показана).
 *
 * Тема тревоги — её заголовок и первый пункт описания. Место названо там —
 * это тревога о нём. Названо в одном из следующих пунктов — это другой пункт
 * сводки (сводки МЧС из соцсетей пишутся пунктами с новой строки), и строка
 * печатает его, а не чужой заголовок.
 */
export function alertLineForPlace(a: AlertMentionRow, placeName: string, origin: string): string | null {
  const needle = norm(placeName.trim());
  if (!needle) return null;
  if (norm(a.title).includes(needle)) {
    const tail = a.description ? `: ${clipAtWord(a.description)}` : '';
    return `[Предупреждение, источник: ${origin}] ${a.title}${tail}`;
  }
  const items = a.description ? descriptionItems(a.description) : [];
  const at = items.findIndex((it) => norm(it).includes(needle));
  if (at < 0) return null;
  if (at === 0) {
    const index = norm(items[0]).indexOf(needle);
    return `[Предупреждение, источник: ${origin}] ${a.title}: ${clipAtWord(items[0], ALERT_SNIPPET_MAX, { index, length: needle.length })}`;
  }
  const found = sentenceWith(items[at], needle);
  const snippet = clipAtWord(found.text, ALERT_SNIPPET_MAX, { index: found.index, length: needle.length });
  return `[Упоминание в сводке, источник: ${origin}] ${snippet}`;
}
