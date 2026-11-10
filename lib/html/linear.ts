/**
 * lib/html/linear.ts — текст чужой страницы за время, линейное по её размеру.
 *
 * `htmlToText` (lib/html/text.js) снимает разметку регулярками, и на
 * повреждённой странице они работают за квадрат. Замер проверки 10.11:
 * страница из одних `<a` без единого `>` — 400 тыс. знаков разбираются 27
 * секунд, рост вчетверо на каждое удвоение; из одних `<script>` без
 * закрывающего — то же. Разбор синхронный, а сервер прода — один процесс: пока
 * он занят, не отвечает ничего, включая SOS. Адрес сайта партнёр вписывает в
 * кабинете сам, то есть страница — чужой, недоверенный ввод.
 *
 * Здесь разметка готовится так, чтобы регулярки `htmlToText` нашли в ней
 * только то, что снимается за один проход. Делается ровно то, что `htmlToText`
 * сделал бы сам, и в том же порядке, — но поиском подстроки, а не регуляркой с
 * возвратами:
 *
 *   1. пары `<script …>…</script …>` и `<style …>…</style …>`;
 *   2. первый `<script …>` и `<style …>` без пары — до конца документа;
 *   3. комментарии, незакрытый — до конца документа;
 *   4. `<br>` и закрытие блока — перевод строки;
 *   5. хвост после последнего `>`: от первого `<имя` и до конца это
 *      незакрытый тег, а не текст страницы.
 *
 * Квадрат в регулярках даёт только попытка, которая не сошлась: `<script>`,
 * после которого нет закрывающего, и `<имя`, после которого нет `>`. После
 * шагов 1–2 первых не остаётся, после шага 5 — вторых.
 *
 * Результат обязан совпадать с `htmlToText` на любой странице: иначе у всех
 * страниц под наблюдением разом сменился бы текст. Это держит сторож
 * tests/unit/html-linear.test.ts — сверкой на случайной разметке и замером
 * времени на повреждённой.
 */
import { htmlToText } from '@/lib/html/text';

const WORD = /[a-z0-9_]/;

/**
 * Регистр — только у латиницы и без смены длины строки: позиции в строке со
 * сниженным регистром должны совпадать с позициями в исходной. Регулярка с
 * флагом `i` тоже приравнивает к `s` только `S`, а не «ſ».
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** Следующее вхождение `needle`, за которым стоит граница слова — как `\b` в регулярке. */
function findWord(lower: string, needle: string, from: number): number {
  for (let at = lower.indexOf(needle, from); at >= 0; at = lower.indexOf(needle, at + 1)) {
    const next = lower[at + needle.length];
    if (next === undefined || !WORD.test(next)) return at;
  }
  return -1;
}

/** Пары `<name …>…</name …>` — пробел. То же, что глобальная регулярка, за один проход. */
function dropPaired(html: string, name: string): string {
  const lower = asciiLower(html);
  const open = `<${name}`;
  const close = `</${name}`;
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = findWord(lower, open, pos);
    if (start < 0) break;
    const openEnd = lower.indexOf('>', start + open.length);
    // Дальше нет «>» или закрывающего тега — не сложится ни эта пара, ни одна следующая.
    if (openEnd < 0) break;
    const closing = findWord(lower, close, openEnd + 1);
    if (closing < 0) break;
    const closeEnd = lower.indexOf('>', closing + close.length);
    if (closeEnd < 0) break;
    out.push(html.slice(pos, start), ' ');
    pos = closeEnd + 1;
  }
  out.push(html.slice(pos));
  return out.join('');
}

/**
 * Первый `<name` без пары — до конца документа: незакрытое тело не текст
 * страницы. Если у него нет и своего `>`, это незакрытый тег — его же срезал
 * бы шаг 5.
 */
function dropUnclosed(html: string, name: string): string {
  const start = findWord(asciiLower(html), `<${name}`, 0);
  return start < 0 ? html : `${html.slice(0, start)} `;
}

/** Комментарии — пробел; незакрытый — до конца документа. */
function dropComments(html: string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start < 0) break;
    out.push(html.slice(pos, start), ' ');
    const end = html.indexOf('-->', start + 4);
    if (end < 0) { pos = html.length; break; }
    pos = end + 3;
  }
  out.push(html.slice(pos));
  return out.join('');
}

/** После последнего `>` тегов быть не может: от первого `<имя` и до конца — незакрытый тег. */
function dropOpenTail(html: string): string {
  const lastClose = html.lastIndexOf('>');
  const at = html.slice(lastClose + 1).search(/<\/?[a-zA-Z]/);
  return at < 0 ? html : `${html.slice(0, lastClose + 1 + at)} `;
}

/**
 * Разметка, на которой `htmlToText` даёт тот же текст, что и на исходной, но
 * за линейное время.
 */
export function tameHtml(html: string): string {
  let s = dropPaired(String(html), 'script');
  s = dropPaired(s, 'style');
  s = dropUnclosed(s, 'script');
  s = dropUnclosed(s, 'style');
  s = dropComments(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  return dropOpenTail(s);
}

/** `htmlToText` для чужой страницы произвольного содержания и размера. */
export function htmlToTextLinear(html: string): string {
  return htmlToText(tameHtml(html));
}
