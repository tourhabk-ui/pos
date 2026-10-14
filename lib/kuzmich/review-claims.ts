/**
 * lib/kuzmich/review-claims.ts — что заметка Кузьмича о месте утверждает
 * сверх данных, по которым её писали (14.10).
 *
 * Повод — слово владельца «кузьмич навыдумывал много» и Вачкажец того же дня.
 * Заметка `places.kuzmich_review` («Кузьмич о месте» на карточке) говорила:
 * «чёрный базальтовый разлом», «часа четыре идти по осыпи и снежнику на одну
 * из трёх вершин», «цирки с айсбергами в чаше озера», «медведи встречаются».
 * В описании места, по которому заметку писали, нет ни четырёх часов, ни
 * трёх вершин, ни медведей; разлом и айсберги — из прежнего описания, которое
 * источник опроверг (миграция 1151), а заметка пережила его правку.
 *
 * Агент (lib/agents/kuzmich-place-enricher.ts) просит модель «не добавлять
 * ничего сверх переданных данных» — и запрет в промпте бессилен, когда сам
 * жанр («личная заметка опытного проводника», «с характером») зовёт к
 * подробностям из опыта, которого нет. Проверка поэтому стоит ПОСЛЕ модели и
 * сверяет текст с теми же данными, что ей дали.
 *
 * Что считается — УЛИКИ, не приговор (как в place-link и description-voice):
 *   diary              — рассказ от первого лица («я», «мы», «поднялся»);
 *   number_not_in_data — число (цифрами или словом: «часа четыре», «трёх
 *                        вершин»), которого нет в описании и высоте;
 *   hazard_not_in_data — опасность (медведи, лавины, камнепад, туман…),
 *                        которой нет ни в описании, ни в произносимом профиле
 *                        безопасности (шаблон 070 не в счёт — profile-source).
 * Впечатление («тишина», «запах серы») — тоже примета, но заметке это жанр;
 * оно считается, а не бракует.
 *
 * Чистый модуль: текст и факты на входе, вердикт на выходе. Им пользуются
 * агент (не сохранить новую выдумку) и перепись `/api/cron/kuzmich-review-census`
 * (сколько выдумок уже на карточках). Сторож: tests/unit/kuzmich-review-claims.test.ts.
 */

import { descriptionVoice } from '@/lib/places/description-voice';

export interface ReviewFacts {
  /** Описание места — то, что агент передаёт модели. */
  description: string | null;
  /** Опасности, которые можно произносить как факт (после honestSafetyFields), — ключи HAZARDS. */
  hazardCodes: readonly string[];
  /** Высота из профиля, если записана. */
  altitudeM: number | null;
}

export type ReviewFlag = 'diary' | 'number_not_in_data' | 'hazard_not_in_data';

export interface ReviewVerdict {
  /** Улики, по которым заметку нельзя выдавать за пересказ данных. */
  flags: ReviewFlag[];
  /** Числа без опоры — как они стоят в заметке. */
  numbers: string[];
  /** Опасности без опоры — ключами HAZARDS. */
  hazards: string[];
  /** Голос заметки — для счёта; впечатление не бракует. */
  voice: 'diary' | 'impression' | 'plain';
}

const L = '(?<![а-яёa-z0-9])';
const R = '(?![а-яёa-z])';

/** Числа словами → значение. Формы — те, что встречаются в заметках. */
const NUMBER_WORDS: ReadonlyArray<{ re: RegExp; value: number }> = [
  { re: new RegExp(`${L}(полтора|полторы|полутора)${R}`, 'giu'), value: 1.5 },
  { re: new RegExp(`${L}(два|две|двух|двум|двумя)${R}`, 'giu'), value: 2 },
  { re: new RegExp(`${L}(три|тр[её]х|тр[её]м|тремя)${R}`, 'giu'), value: 3 },
  { re: new RegExp(`${L}(четыре|четыр[её]х|четырьмя)${R}`, 'giu'), value: 4 },
  { re: new RegExp(`${L}(пять|пяти|пятью)${R}`, 'giu'), value: 5 },
  { re: new RegExp(`${L}(шесть|шести)${R}`, 'giu'), value: 6 },
  { re: new RegExp(`${L}(семь|семи)${R}`, 'giu'), value: 7 },
  { re: new RegExp(`${L}(восемь|восьми)${R}`, 'giu'), value: 8 },
  { re: new RegExp(`${L}(девять|девяти)${R}`, 'giu'), value: 9 },
  { re: new RegExp(`${L}(десять|десяти)${R}`, 'giu'), value: 10 },
  { re: new RegExp(`${L}(двадцать|двадцати)${R}`, 'giu'), value: 20 },
  { re: new RegExp(`${L}(тридцать|тридцати)${R}`, 'giu'), value: 30 },
  { re: new RegExp(`${L}(сорок|сорока)${R}`, 'giu'), value: 40 },
  { re: new RegExp(`${L}(пятьдесят|пятидесяти)${R}`, 'giu'), value: 50 },
  { re: new RegExp(`${L}(сто|ста)${R}`, 'giu'), value: 100 },
  { re: new RegExp(`${L}(полчаса|получаса)${R}`, 'giu'), value: 0.5 },
];

/** Цифры: «1556», «1 556», «2,5», «900°C» → значение. Пробел внутри числа — разряды. */
const DIGITS = /(?<![\d.,])\d{1,3}(?:[\s ]\d{3})+(?![\d])|\d+(?:[.,]\d+)?/g;

function digitValues(text: string): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  for (const m of text.matchAll(DIGITS)) {
    const raw = m[0];
    const value = Number(raw.replace(/[\s ]/g, '').replace(',', '.'));
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

function wordValues(text: string): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  for (const { re, value } of NUMBER_WORDS) {
    for (const m of text.matchAll(re)) out.push({ raw: m[0], value });
  }
  return out;
}

/** Все значения чисел в тексте — цифрами и словами. */
function numberValues(text: string): Array<{ raw: string; value: number }> {
  return [...digitValues(text), ...wordValues(text)];
}

/**
 * Опасность → как она звучит в заметке и в описании. Ключи — те же, что у
 * HAZARDS (lib/safety/hazard-labels), чтобы сверять с профилем.
 */
const HAZARD_WORDS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: 'bears', re: /(?<![а-яё])медвед/i },
  { key: 'avalanche', re: /(?<![а-яё])лавин/i },
  { key: 'rockfall', re: /(?<![а-яё])(камнепад|осыпающ)/i },
  { key: 'fog', re: /(?<![а-яё])туман/i },
  { key: 'river_crossing', re: /(?<![а-яё])(брод|переправ)/i },
  { key: 'thermal', re: /(?<![а-яё])(кипят|кипящ|ожог|обжиг|термальн[а-яё]* (пол|площадк|зон))/i },
  { key: 'volcanic_gas', re: /(?<![а-яё])(сероводород|вулканическ[а-яё]* газ|ядовит[а-яё]* газ)/i },
  { key: 'crevasses', re: /(?<![а-яё])трещин/i },
  { key: 'flash_flood', re: /(?<![а-яё])(паводк|паводок|сел[ьяи](?![а-яё]))/i },
  { key: 'ice', re: /(?<![а-яё])(наледь|наледи|гололёд|гололед)/i },
  { key: 'no_signal', re: /(?<![а-яё])(связи нет|нет связи|без связи)/i },
];

export function reviewClaims(review: string, facts: ReviewFacts): ReviewVerdict {
  const text = review ?? '';
  const description = facts.description ?? '';
  const flags: ReviewFlag[] = [];

  const { voice } = descriptionVoice(text);
  if (voice === 'diary') flags.push('diary');

  // Число опирается на данные, если то же значение есть в описании или это высота.
  const known = new Set<number>(numberValues(description).map((n) => n.value));
  if (facts.altitudeM !== null) known.add(facts.altitudeM);
  const numbers = [...new Set(numberValues(text).filter((n) => !known.has(n.value)).map((n) => n.raw))];
  if (numbers.length > 0) flags.push('number_not_in_data');

  const allowed = new Set(facts.hazardCodes);
  const hazards = HAZARD_WORDS
    .filter((h) => h.re.test(text) && !h.re.test(description) && !allowed.has(h.key))
    .map((h) => h.key);
  if (hazards.length > 0) flags.push('hazard_not_in_data');

  return { flags, numbers, hazards, voice };
}

/**
 * Почему уже стоящую заметку нужно переписать — или null, если не нужно
 * (14.10, слово владельца «1 да»: заметки с уликами — на перезапись агенту
 * с новой проверкой).
 *
 *   evidence          — у заметки улика (reviewClaims): сказано сверх данных;
 *   diary_description — описание места, по которому заметку писали, — путевая
 *                       заметка. Число и опасность из него проверку проходят,
 *                       потому что «есть в данных», а данные сами сочинены:
 *                       пересказ выдумки — та же выдумка.
 */
export type RewriteReason = 'evidence' | 'diary_description';

export function reviewRewriteReason(review: string, facts: ReviewFacts): RewriteReason | null {
  if (descriptionVoice(facts.description).voice === 'diary') return 'diary_description';
  return reviewClaims(review, facts).flags.length > 0 ? 'evidence' : null;
}
