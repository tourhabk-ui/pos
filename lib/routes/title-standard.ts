/**
 * lib/routes/title-standard.ts — стандарт имени маршрута (владелец 20.08).
 *
 * «Один формат названия, без поэзии». Имя маршрута называет ОБЪЕКТ или
 * ПУТЬ, а не впечатление:
 *   «Вулкан Горелый»                    — радиальный к объекту;
 *   «Пиначево — Центральный»            — линейный, старт — финиш;
 *   «Водопад Спокойный (Снежный Барс)»  — уточнение в скобках;
 *   «Сплав по реке Быстрая»             — активность впереди, когда она суть;
 *   «Горный массив Вачкажец (лыжный)»   — вариант в скобках.
 *
 * Поэзия мешает не вкусом, а работой: «Идеальный выходной» не находится
 * поиском, не сличается с местами по имени (все сегодняшние чистки ловили
 * дубли ИМЕНЕМ) и ничего не обещает человеку, выбирающему путь в поле.
 *
 * Судья детерминированный: каждое нарушение — проверяемый признак, а не
 * мнение. Он ничего не переименовывает — переименование сочиняет смысл,
 * и это работа человека по списку переписи.
 */

/** Маркетинговые эпитеты — явный список, расширяется только правкой. */
const POETRY_WORDS = new Set([
  'приключение', 'приключения', 'идеальный', 'идеальная', 'незабываемый',
  'незабываемая', 'незабываемо', 'глазами', 'сказка', 'сказочный', 'мечта',
  'мечты', 'магия', 'магический', 'чудо', 'чудеса', 'рай', 'эмоции',
  'вдохновение', 'лучший', 'лучшая',
]);

/** Однобуквенные и частые сокращения, после которых точка — не конец фразы. */
const ABBREV = /(?:^|\s)(?:о|п|г|с|р|б|им|пр|ул)\.$/i;

const MAX_WORDS = 7;

export interface TitleVerdict {
  ok: boolean;
  violations: string[];
}

/** Значимые слова: как в семье имён — пробелы и дефисы, пунктуация по краям. */
function words(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[\s]+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(t => t.length > 0);
}

export function judgeRouteTitle(title: string): TitleVerdict {
  const violations: string[] = [];
  const t = title.trim();

  if (/[!?]/.test(t)) violations.push('восклицание или вопрос');
  if (/…|\.{3}/.test(t)) violations.push('многоточие');
  if (/[«»"“”]/.test(t)) violations.push('кавычки-лозунг');

  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    violations.push('капс');
  }

  // Точка как граница предложения: имя из нескольких фраз — это анонс, не
  // имя. Точка после сокращения («о. Беринга», «п. Ключи») не считается.
  const dotSplits = t.split(/\.\s+/);
  if (dotSplits.length > 1) {
    const sentenceDots = dotSplits
      .slice(0, -1)
      .filter(part => !ABBREV.test(part + '.'));
    if (sentenceDots.length > 0) violations.push('предложения через точку');
  }

  const ws = words(t);
  const poetic = ws.filter(w => POETRY_WORDS.has(w));
  if (poetic.length > 0) violations.push(`эпитеты: ${poetic.join(', ')}`);

  if (ws.length > MAX_WORDS) violations.push(`длиннее ${MAX_WORDS} слов`);

  return { ok: violations.length === 0, violations };
}
