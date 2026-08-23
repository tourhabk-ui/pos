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
 */

'use strict';

/** Сколько раз повторять снятие. Больше двух витков в живом HTML не встречается. */
const MAX_PASSES = 5;

/** Тег: `<имя ...>` или `</имя ...>`. Имя обязательно — иначе это просто «меньше». */
const TAG = /<\/?[a-zA-Z][^>]*>/g;

/** Комментарий, включая незакрытый в обрезанном по потолку HTML. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Убирает script и style ВМЕСТЕ С ТЕЛОМ.
 *
 * `\b[^>]*>` в закрывающем теге — то место, где ошибались все семь копий.
 * Второй заход по `<script...>` до конца документа нужен для HTML, обрезанного
 * по потолку размера: незакрытое тело — тоже не текст страницы.
 *
 * @param {string} html
 * @param {string} [separator=' ']
 * @returns {string}
 */
function stripScriptsAndStyles(html, separator = ' ') {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, separator)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, separator)
    .replace(/<script\b[^>]*>[\s\S]*$/i, separator)
    .replace(/<style\b[^>]*>[\s\S]*$/i, separator);
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
  let out = stripScriptsAndStyles(String(html), separator).replace(COMMENT, separator);
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = out.replace(TAG, separator);
    if (next === out) break;
    out = next;
  }
  // Незакрытый тег в конце документа: `<div class="x` — это не текст.
  return out.replace(/<\/?[a-zA-Z][^>]*$/, separator);
}

/**
 * Разметка → текст с сохранением абзацев: `<br>` и закрытие блока дают перевод
 * строки. Для прозы (описания, статьи), а не для короткого сниппета.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  const withBreaks = stripScriptsAndStyles(String(html), ' ')
    .replace(COMMENT, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n');
  return stripTags(withBreaks, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { stripTags, stripScriptsAndStyles, htmlToText, MAX_PASSES };
