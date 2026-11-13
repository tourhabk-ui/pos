/**
 * На каком языке написан текст — по письменности, без модели. Чистый модуль:
 * его зовут сообщения адресатам заявок и срез журнала A2A, которым незачем
 * тянуть за собой провайдеров ИИ. Сам перевод — lib/ai/translate-text.
 *
 * Сторож: tests/unit/translate-text.test.ts.
 */

// Язык текста судится по СЛОВАМ, а не по буквам: в русском ответе Кузьмича
// стоят латинские названия туров и адреса страниц, и по буквам такой ответ
// выходил «иностранным». Иероглиф, кана и слог хангыля считаются каждый за
// слово: «我们想去火山» — шесть знаков без единого пробела и целая фраза.
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNITS = /\p{Script=Cyrillic}+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|\p{L}+/gu;
const CYRILLIC_START = /^\p{Script=Cyrillic}/u;
const LINK = /https?:\/\/\S+|\bwww\.\S+/gi;
/** Доля русских слов, с которой текст считается русским. */
const RUSSIAN_SHARE = 0.5;
/** Сколько иероглифов допустимо в переводе: имя собственное, не фраза. */
export const LEFTOVER_DENSE_SHARE = 0.2;
/** Во сколько знаков русского текста разворачивается один иероглиф. */
const DENSE_CHARS = 3;

export interface ScriptUnits { cyr: number; dense: number; all: number }

export function scriptUnits(text: string): ScriptUnits {
  const u: ScriptUnits = { cyr: 0, dense: 0, all: 0 };
  for (const m of text.replace(LINK, ' ').matchAll(UNITS)) {
    u.all += 1;
    if (DENSE.test(m[0])) u.dense += 1;
    else if (CYRILLIC_START.test(m[0])) u.cyr += 1;
  }
  return u;
}

/** Доля русских слов в тексте; null — слов нет вовсе (цифры, знаки, ссылки). */
export function russianShare(text: string): number | null {
  const u = scriptUnits(text);
  return u.all === 0 ? null : u.cyr / u.all;
}

/** Нужен ли тексту перевод на русский: слова есть, и русских среди них меньше половины. */
export function needsRussian(text: string | null | undefined): boolean {
  const share = russianShare(text ?? '');
  return share !== null && share < RUSSIAN_SHARE;
}

/** Длина текста в «русских» знаках: иероглиф разворачивается в несколько букв. */
export function russianLength(text: string): number {
  let n = 0;
  for (const ch of text) n += DENSE.test(ch) ? DENSE_CHARS : 1;
  return n;
}
