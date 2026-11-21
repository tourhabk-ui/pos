/**
 * Fail-closed для цены, наличия мест и статуса маршрута в ответе Кузьмича.
 *
 * Эти факты допустимы только если в ЭТОМ ходе инструмент вернул данные,
 * в которых то же утверждение есть. Контекст промпта (каталог, сводка) сюда
 * не считается: задача — не повторять цифру из подсказки, а опереться на
 * результат своего инструмента. Нет журнала инструментов или инструмент
 * не принёс данных — «не смог проверить», утверждение заменяется.
 */

import type { ToolRun } from '@/lib/agents/eval/grounding';

export const OFFER_HONEST_LINE = 'не подтверждаю, данных нет — уточнит оператор';

/** Фразы, где мы уже честно отказываемся подтверждать — их не трогаем. */
const ALREADY_HONEST =
  /не подтверждаю|подтвердит оператор|подтверждает оператор|уточнит оператор|заявку подтверждает человек|цены? нет в данных|мест не подтвержда/i;

const PRICE_RE =
  /(\d(?:[\s\u00a0]?\d){0,8}(?:[.,]\d+)?)\s*(?:₽|руб(?:л[а-яё]*)?|yuan|cny|usd|eur|¥|\$|€)(?![а-яё])/gi;
// «от 5 лет», «от 7 дней», «от 2 человек» — не цена (тест 21.11): без
// инструмента такое предложение затиралось целиком.
const NOT_MONEY_AFTER = '(?![\\d\\s\\u00a0]*(?:лет|год|дн|день|недел|час|ч(?![а-яё])|км|м(?![а-яё])|чел|человек|мест|°|%|раз|ночей|ноч|сут))';
const PRICE_VERB_RE = new RegExp(`(?<![а-яё])(цена(?![а-яё])|(?:стоит|стоят)\\s+\\d${NOT_MONEY_AFTER}|от\\s+\\d${NOT_MONEY_AFTER})`, 'i');

const AVAIL_RE =
  /(?<![а-яё])(мест\s+нет|нет\s+мест|есть\s+места|свободн[а-яё]*\s+мест[а-яё]*|места\s+законч[а-яё]*|набор\s+открыт|группа\s+набрана|остал(?:ось|ись)\s+\d+[^\n.]{0,20}мест)/i;

const ROUTE_STATUS_RE =
  /(?<![а-яё])((?:маршрут|перевал|трасса|дорога)[а-яё]*\s+(?:открыт[а-яё]*|закрыт[а-яё]*))/i;

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

function normalizeAmount(raw: string): string {
  // «60000.00» в выводе и «60 000» в ответе — одна сумма (тест 21.11: копейки
  // из базы давали ложное «не подтверждаю» при цене из инструмента).
  return raw.replace(/[\s\u00a0]/g, '').replace(',', '.').replace(/\.0+$/, '');
}

function evidenceFromTools(toolRuns: readonly ToolRun[] | null): string {
  return (toolRuns ?? [])
    .filter((r) => r.producedData && r.output)
    .map((r) => r.output)
    .join('\n');
}

function amountsIn(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(PRICE_RE.source, PRICE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.push(normalizeAmount(m[1]));
  return found;
}

function priceBacked(sentence: string, evidence: string): boolean {
  const claimed = amountsIn(sentence);
  if (claimed.length === 0) return !PRICE_VERB_RE.test(sentence) || amountsIn(evidence).length > 0;
  if (!evidence) return false;
  const have = new Set(amountsIn(evidence));
  return claimed.every((n) => have.has(n));
}

function availBacked(sentence: string, evidence: string): boolean {
  const claim = sentence.match(AVAIL_RE);
  if (!claim) return true;
  if (!evidence) return false;
  const token = claim[1].toLowerCase();
  const ev = evidence.toLowerCase();
  if (/нет|законч/.test(token)) return /мест\s*нет|нет\s*мест|свободн[а-яё]*\s+мест нет|места\s+законч/.test(ev);
  if (/набрана/.test(token)) return /набрана|мест нет|нет мест/.test(ev);
  if (/набор\s+открыт|есть\s+места|свободн/.test(token) || /остал/.test(token)) {
    return /есть\s+места|свободн|набор\s+открыт|мест[а-яё]*\s+\d+|\d+[^\n.]{0,12}мест/.test(ev);
  }
  return ev.includes(token);
}

function routeStatusBacked(sentence: string, evidence: string): boolean {
  const claim = sentence.match(ROUTE_STATUS_RE);
  if (!claim) return true;
  if (!evidence) return false;
  const phrase = claim[1].toLowerCase().replace(/\s+/g, ' ');
  const ev = evidence.toLowerCase();
  if (ev.includes(phrase)) return true;
  const closed = /закрыт/.test(phrase);
  const kind = phrase.match(/маршрут|перевал|трасса|дорога/)?.[0];
  if (!kind) return false;
  const status = closed ? /закрыт/ : /открыт/;
  // То же состояние того же типа объекта — достаточно; имя могло быть рядом.
  const window = ev.match(new RegExp(`.{0,40}${kind}.{0,40}`, 'g')) ?? [];
  return window.some((w) => status.test(w));
}

function sentenceNeedsOffer(sentence: string): boolean {
  if (ALREADY_HONEST.test(sentence)) return false;
  PRICE_RE.lastIndex = 0;
  return PRICE_RE.test(sentence) || PRICE_VERB_RE.test(sentence) || AVAIL_RE.test(sentence) || ROUTE_STATUS_RE.test(sentence);
}

function sentenceBacked(sentence: string, evidence: string): boolean {
  if (PRICE_RE.test(sentence) || PRICE_VERB_RE.test(sentence)) {
    if (!priceBacked(sentence, evidence)) return false;
  }
  if (AVAIL_RE.test(sentence) && !availBacked(sentence, evidence)) return false;
  if (ROUTE_STATUS_RE.test(sentence) && !routeStatusBacked(sentence, evidence)) return false;
  return true;
}

/** Журнал «своих данных хода»: витрина, собранная этим ходом без модели. */
export function catalogToolRuns(output: string): ToolRun[] {
  const text = output.trim();
  if (!text) return [];
  return [{ name: 'catalog', producedData: true, output: text }];
}

/**
 * Строка на месте неподтверждённой цифры (тест планировщика 21.11). До этого
 * предложение без «сути» после вырезания цены менялось на голую строку
 * OFFER_HONEST_LINE, и она висела первой строкой ответа без контекста: не
 * понять, какую цену не подтверждаем. Теперь строка встаёт на место самой
 * цифры, и рядом остаётся, о чём она: «Горелый — цену не подтверждаю, …».
 */
export const OFFER_PRICE_LINE = `цену ${OFFER_HONEST_LINE}`;
const OFFER_SEATS_LINE = `наличие мест ${OFFER_HONEST_LINE}`;
const OFFER_ROUTE_LINE = `Статус маршрута ${OFFER_HONEST_LINE}.`;
const OFFER_PRICE_SENTENCE = `Цену ${OFFER_HONEST_LINE}.`;

/** Цена вместе со своими словами: «от», «около», «стоит», единица после. */
const PRICE_PHRASE_RE = new RegExp(
  `(?:(?:стоит|стоят|стоимость|цена|по\\s+цене)[\\s:—–-]*)?(?:(?:от|около|примерно|~|≈)\\s*)?${PRICE_RE.source}`
  + `(?:\\s*(?:\\/\\s*)?(?:за|с|на)?\\s*(?:чел(?:овека|\\.)?|человек|группу|группа|день|сутки|ночь|тур|персону)(?![а-яё]))?(?:\\s*(?:в|за)\\s+(?:день|сутки))?`,
  'gi',
);

function replaceUnbackedPrices(sentence: string, evidence: string): string {
  const have = new Set(amountsIn(evidence));
  return sentence.replace(PRICE_PHRASE_RE, (full: string, raw: string, offset: number) => {
    if (have.has(normalizeAmount(raw))) return full;
    // «Тур стоит 28 000 ₽» → «Тур — цену не подтверждаю…»: после слова — тире.
    const before = sentence.slice(0, offset);
    return /[\p{L}\d»"]\s*$/u.test(before) ? `— ${OFFER_PRICE_LINE}` : OFFER_PRICE_LINE;
  });
}

function replaceUnbackedSeats(sentence: string): string {
  return sentence.replace(new RegExp(AVAIL_RE.source, 'gi'), OFFER_SEATS_LINE);
}

function redactSentence(sentence: string, evidence: string): { text: string; removed: boolean } {
  if (!sentenceNeedsOffer(sentence)) return { text: sentence, removed: false };
  PRICE_RE.lastIndex = 0;
  if (sentenceBacked(sentence, evidence)) return { text: sentence, removed: false };

  // Статус маршрута без опоры — предложение целиком: он и есть его суть, а
  // причина рядом («из-за снега») без статуса тоже утверждение. Строка
  // называет, что не подтверждено.
  if (ROUTE_STATUS_RE.test(sentence) && !routeStatusBacked(sentence, evidence)) {
    return { text: OFFER_ROUTE_LINE, removed: true };
  }

  let out = sentence;
  if (amountsIn(out).length > 0) out = replaceUnbackedPrices(out, evidence);
  PRICE_RE.lastIndex = 0;
  if (AVAIL_RE.test(out) && !availBacked(out, evidence)) out = replaceUnbackedSeats(out);
  PRICE_RE.lastIndex = 0;
  // Цена словами без цифры («цена ниже, чем у…») без опоры — предложение
  // целиком, но со словом «цену»: понятно, что именно не подтверждено.
  if (amountsIn(sentence).length === 0 && (PRICE_VERB_RE.test(out)) && !priceBacked(out, evidence)) {
    return { text: OFFER_PRICE_SENTENCE, removed: true };
  }
  // Повторы строки подряд («… цену не подтверждаю … цену не подтверждаю») — одна.
  const twice = new RegExp(`(${OFFER_PRICE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?:[\\s,;и–—-]+\\1)+`, 'g');
  out = out.replace(twice, '$1');
  // Предложение начиналось с заглавной — и после замены тоже.
  if (/^\p{Lu}/u.test(sentence.trimStart()) && /^\p{Ll}/u.test(out.trimStart())) {
    const lead = out.length - out.trimStart().length;
    out = out.slice(0, lead) + out.charAt(lead).toUpperCase() + out.slice(lead + 1);
  }
  return { text: out, removed: out !== sentence };
}

export interface OfferGuardResult {
  text: string;
  removed: string[];
}

/** Предложения строки и разделители между ними — чтобы собрать строку как была. */
function sentencePieces(line: string): string[] {
  return line.split(/(?<=[.!?])([ \t]+)/);
}

/**
 * Цена, места или статус маршрута без опоры в выводе инструментов этого хода
 * заменяются честной строкой на месте самого утверждения. Переводы строк
 * сохраняются: до 21.11 предложения абзаца склеивались пробелом, и список
 * «- пункт.\n- пункт» становился одной строкой «- пункт. - пункт».
 */
export function guardOfferClaims(answer: string, toolRuns: readonly ToolRun[] | null): OfferGuardResult {
  const evidence = evidenceFromTools(toolRuns);
  const removed: string[] = [];
  const lines = answer.split('\n').map((line) => {
    if (!line.trim()) return line;
    return sentencePieces(line).map((piece, i) => {
      if (i % 2 === 1) return piece; // разделитель
      const out = redactSentence(piece, evidence);
      if (out.removed) removed.push(piece);
      return out.text;
    }).join('');
  });
  return { text: lines.join('\n'), removed };
}
