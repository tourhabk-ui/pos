/**
 * lib/html/text.js — разметка в текст. ОДНА реализация на весь репозиторий.
 *
 * Модуль намеренно CommonJS: его зовут и приложение (TS, `allowJs: true`), и
 * standalone-скрейперы, которые запускают голым `node` без tsx. Иначе пришлось
 * бы держать две копии, а копии этого правила уже разъезжались.
 *
 * 23.08.2026 CodeQL напечатал 44 находки на разборе чужого HTML — два разных
 * дефекта, оба в одних и тех же функциях:
 *
 * 1. js/bad-tag-filter (7): `<\/script>` требует закрывающий тег ровно таким.
 *    Браузер принимает `</script >`, `</script\n>` и даже `</script foo>` —
 *    атрибуты закрывающего тега он игнорирует. Пока регулярка требовала
 *    точного вида, ТЕЛО СКРИПТА оставалось в «тексте страницы» и уезжало
 *    дальше — в промпт модели, в описание маршрута, в пост канала.
 *
 * 2. js/incomplete-multi-character-sanitization (37): `.replace(/<[^>]+>/g,'')`
 *    за один проход. Снятие тегов может СОБРАТЬ новый: `<<a>script>` после
 *    удаления `<a>` превращается в `<script>`. И незакрытый `<script src=x`
 *    без `>` переживает замену целиком.
 *
 * Здесь оба закрыты: закрывающий тег читается как браузером, а снятие идёт до
 * неподвижной точки — пока строка меняется.
 *
 * Заодно исправлено то, на что CodeQL не указывал, но что портило текст:
 * `<[^>]+>` съедал «1 < 2 и 3 > 4» целиком, потому что не требовал имени тега
 * после `<`. Теперь требует.
 *
 * 10.11.2026 — время разбора линейно по размеру входа. Прежние регулярки на
 * повреждённой разметке работали за квадрат: `stripTags` на 600 тыс. знаков из
 * одних `<a ` без `>` — 44 секунды, `stripScriptsAndStyles` на 800 тыс. из
 * `<script ` — минута. Квадрат давала только попытка, которая не сошлась:
 * `<script`, после которого нет закрывающего тега, и `<имя`, после которого
 * нет `>` — каждая такая попытка читала строку до конца. Хуже всего были
 * открывающие `<script>`, за которыми шли закрывающие без `>`: каждая пара
 * перебиралась с каждой, и 16 КБ такой страницы держали процесс три секунды. Разбор синхронный, а
 * сервер прода — один процесс: пока он занят, не отвечает ничего, включая SOS;
 * чужую страницу сюда приносят и кроны, и адрес, вписанный партнёром.
 *
 * Правило каждой функции прежнее, и текст на выходе тот же — меняется способ:
 * пары и хвост ищутся поиском подстроки, а регулярка тега получает только ту
 * часть строки, где каждый `<имя` закрыт. Совпадение с прежними регулярками на
 * случайной разметке и время на повреждённой держит сторож
 * tests/unit/html-linear.test.ts.
 *
 * Разделитель — строка, и это обычный текст: `$&` в нём ничего не значит.
 */

'use strict';

/** Сколько раз повторять снятие. Больше двух витков в живом HTML не встречается. */
const MAX_PASSES = 5;

/** Тег: `<имя ...>` или `</имя ...>`. Имя обязательно — иначе это просто «меньше». */
const TAG = /<\/?[a-zA-Z][^>]*>/g;

/** Начало тега — то, с чего начинается и незакрытый. */
const TAG_START = /<\/?[a-zA-Z]/;

/** Комментарий, включая незакрытый в обрезанном по потолку HTML. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** Есть ли в разметке хоть один кандидат в script или style: без него искать пары незачем. */
const SCRIPT_OR_STYLE = /<s(?:cript|tyle)/i;

const WORD = /[A-Za-z0-9_]/;

/**
 * Строка в нижнем регистре ТОЙ ЖЕ длины: позиции в ней обязаны совпадать с
 * позициями в исходной.
 *
 * `toLowerCase` работает на порядок быстрее замены по сериям заглавных
 * (страница в 3 млн знаков чередующегося регистра: 0,2 с против 2,5 с), но
 * длину меняет одна буква — «İ»: из неё выходит «i» и отдельная точка. Она
 * заранее подменяется на «ı» — ту же длину и не букву из слов script и style.
 * Ни одна буква вне латиницы в букву этих слов при снижении не превращается,
 * так что находки те же, что у регулярки с флагом `i`: к `s` она приравнивает
 * только `S`, а не «ſ». Если длина всё же разошлась, регистр снижается только
 * у латиницы — медленно, но с теми же позициями.
 *
 * @param {string} s
 * @returns {string}
 */
function lowerSameLength(s) {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  const dotless = s.replace(/\u0130/g, '\u0131').toLowerCase();
  return dotless.length === s.length ? dotless : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Следующее вхождение `needle`, за которым стоит граница слова, — как `\b` в
 * регулярке: `<scripts>` — не script. Граница судится по исходной строке: в
 * сниженной знак Кельвина «K» стал бы буквой «k», а для `\b` он не буква.
 *
 * @param {string} html исходная строка
 * @param {string} lower она же в нижнем регистре той же длины
 * @param {string} needle
 * @param {number} from
 * @returns {number}
 */
function findWord(html, lower, needle, from) {
  for (let at = lower.indexOf(needle, from); at >= 0; at = lower.indexOf(needle, at + 1)) {
    const next = html[at + needle.length];
    if (next === undefined || !WORD.test(next)) return at;
  }
  return -1;
}

/**
 * Пары `<name …>…</name …>` — разделитель. То же, что глобальная регулярка
 * `<name\b[^>]*>[\s\S]*?<\/name\b[^>]*>`, но за один проход.
 *
 * Выход из цикла на первой несложившейся паре — не упрощение: если у этого
 * открывающего тега нет `>`, закрывающего тега или `>` у закрывающего, то их
 * нет и у каждого следующего — искать дальше значит читать тот же хвост снова.
 *
 * @param {string} html
 * @param {string} name
 * @param {string} separator
 * @returns {string}
 */
function dropPaired(html, name, separator) {
  const lower = lowerSameLength(html);
  const open = `<${name}`;
  const close = `</${name}`;
  const out = [];
  let pos = 0;
  for (;;) {
    const start = findWord(html, lower, open, pos);
    if (start < 0) break;
    const openEnd = lower.indexOf('>', start + open.length);
    if (openEnd < 0) break;
    const closing = findWord(html, lower, close, openEnd + 1);
    if (closing < 0) break;
    const closeEnd = lower.indexOf('>', closing + close.length);
    if (closeEnd < 0) break;
    out.push(html.slice(pos, start), separator);
    pos = closeEnd + 1;
  }
  if (pos === 0) return html;
  out.push(html.slice(pos));
  return out.join('');
}

/**
 * Первый `<name …>` без пары — до конца документа: то же, что регулярка
 * `<name\b[^>]*>[\s\S]*$`. Ей нужен `>` где-нибудь после открывающего тега;
 * если его нет у первого, нет и у остальных.
 *
 * @param {string} html
 * @param {string} name
 * @param {string} separator
 * @returns {string}
 */
function dropUnclosed(html, name, separator) {
  const start = findWord(html, lowerSameLength(html), `<${name}`, 0);
  if (start < 0 || html.lastIndexOf('>') < start) return html;
  return html.slice(0, start) + separator;
}

/**
 * Убирает script и style ВМЕСТЕ С ТЕЛОМ.
 *
 * Закрывающий тег читается как браузером (`</script >`, `</script foo>`) — то
 * место, где ошибались все семь копий. Второй заход — первый `<script...>` до
 * конца документа — нужен для HTML, обрезанного по потолку размера:
 * незакрытое тело — тоже не текст страницы.
 *
 * @param {string} html
 * @param {string} [separator=' ']
 * @returns {string}
 */
function stripScriptsAndStyles(html, separator = ' ') {
  const sep = `${separator}`;
  let out = String(html);
  if (!SCRIPT_OR_STYLE.test(out)) return out;
  out = dropPaired(out, 'script', sep);
  out = dropPaired(out, 'style', sep);
  out = dropUnclosed(out, 'script', sep);
  return dropUnclosed(out, 'style', sep);
}

/**
 * Один виток снятия тегов: то же, что `s.replace(TAG, separator)`.
 *
 * Тег кончается на `>`, значит весь лежит не дальше последнего `>` строки.
 * Регулярка получает только эту часть: в ней у каждого `<имя` есть свой `>`, и
 * ни одна попытка не читает строку до конца впустую. Хвост после последнего
 * `>` тегов не содержит — он остаётся как был.
 *
 * @param {string} s
 * @param {string} separator
 * @returns {string}
 */
function dropTagsOnce(s, separator) {
  const last = s.lastIndexOf('>');
  if (last < 0) return s;
  return s.slice(0, last + 1).replace(TAG, () => separator) + s.slice(last + 1);
}

/**
 * Незакрытый тег в конце документа: `<div class="x` — это не текст. То же,
 * что регулярка `<\/?[a-zA-Z][^>]*$`: она сходится на первом начале тега,
 * после которого нет ни одного `>`, то есть на первом после последнего `>`.
 *
 * @param {string} s
 * @param {string} separator
 * @returns {string}
 */
function dropOpenTail(s, separator) {
  const last = s.lastIndexOf('>');
  const at = s.slice(last + 1).search(TAG_START);
  return at < 0 ? s : s.slice(0, last + 1 + at) + separator;
}

/**
 * Разметка → плоский текст.
 *
 * Прямая замена для `.replace(/<[^>]+>/g, X)`: тот же разделитель, но без двух
 * дыр — тело скрипта не остаётся, и снятие идёт до неподвижной точки.
 *
 * @param {string} html
 * @param {string} [separator=''] чем заменять тег: '' или ' ' — как было на месте вызова
 * @returns {string}
 */
function stripTags(html, separator = '') {
  const sep = `${separator}`;
  let out = stripScriptsAndStyles(String(html), sep).replace(COMMENT, () => sep);
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = dropTagsOnce(out, sep);
    if (next === out) break;
    out = next;
  }
  return dropOpenTail(out, sep);
}

/**
 * Разметка → текст с сохранением абзацев: `<br>` и закрытие блока дают перевод
 * строки. Для прозы (описания, статьи), а не для короткого сниппета.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  // `tr` в списке с 29.08: строки таблицы иначе слипались в одну. Заметно
  // это стало на технической документации, где в таблицах лежат ЧИСЛА
  // (полоса частот и предел мощности в соседних строках склеивались, и
  // модель получала «864-865 25 мВт 868,7-869,2 100 мВт» одной строкой —
  // разобрать, что к чему относится, по такому входу нельзя).
  const withBreaks = stripScriptsAndStyles(String(html), ' ')
    .replace(COMMENT, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  return stripTags(withBreaks, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { stripTags, stripScriptsAndStyles, htmlToText, MAX_PASSES };
