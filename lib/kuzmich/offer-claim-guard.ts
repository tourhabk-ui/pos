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
const PRICE_VERB_RE = /(?<![а-яё])(цена(?![а-яё])|(?:стоит|стоят)\s+\d|от\s+\d)/i;

const AVAIL_RE =
  /(?<![а-яё])(мест\s+нет|нет\s+мест|есть\s+места|свободн[а-яё]*\s+мест[а-яё]*|места\s+законч[а-яё]*|набор\s+открыт|группа\s+набрана|остал(?:ось|ись)\s+\d+[^\n.]{0,20}мест)/i;

const ROUTE_STATUS_RE =
  /(?<![а-яё])((?:маршрут|перевал|трасса|дорога)[а-яё]*\s+(?:открыт[а-яё]*|закрыт[а-яё]*))/i;

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

function normalizeAmount(raw: string): string {
  return raw.replace(/[\s\u00a0]/g, '').replace(',', '.');
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

export interface OfferGuardResult {
  text: string;
  removed: string[];
}

/**
 * Предложения с ценой, местами или статусом маршрута без опоры в выводе
 * инструментов этого хода заменяются честной строкой.
 */
export function guardOfferClaims(answer: string, toolRuns: readonly ToolRun[] | null): OfferGuardResult {
  const evidence = evidenceFromTools(toolRuns);
  const removed: string[] = [];
  const paragraphs = answer.split(/\n{2,}/);
  const next = paragraphs.map((p) => {
    const parts = splitSentences(p);
    const kept = parts.map((s) => {
      if (!sentenceNeedsOffer(s)) return s;
      // lastIndex у глобального PRICE_RE сбивает повторную проверку.
      PRICE_RE.lastIndex = 0;
      if (sentenceBacked(s, evidence)) return s;
      removed.push(s);
      return OFFER_HONEST_LINE;
    });
    return kept.join(' ');
  });
  return { text: next.join('\n\n'), removed };
}
