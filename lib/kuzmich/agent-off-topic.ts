/**
 * Не по теме от внешнего ИИ-агента (A2A, 02.11): викторины, загадки,
 * головоломки, крипто- и инвестпредложения. Кузьмич на них не отвечает —
 * вежливый отказ одной фразой и что он умеет. Заявки подтверждает оператор.
 */

import { detectEmergency } from '@/lib/safety/sos-detector';

/** Крипто и инвестпредложения: отказ, даже если рядом слово «Камчатка». */
const CRYPTO_RE = /крипт|биткоин|bitcoin|\bbtc\b|\beth\b|ethereum|блокчейн|blockchain|\bnft\b|airdrop|аирдроп|токен(?:ы|ов)?\b|\btokens?\b|\bcrypto|\busdt\b|инвестиц|\binvest(?:ment|ments|or|ors|ing)?\b|майнинг|\bmining\b|web3|\bdefi\b|presale/i;
/** Викторины и задачки: отказ, если вопрос не про поездку. */
const QUIZ_RE = /викторин|загадк|головоломк|ребус|квиз|\bquiz|\bpuzzle|\briddle|trivia|brain ?teaser|реши (?:задач|уравнен|пример)|solve (?:this|the)|сколько будет \d|what is \d+\s*[-+*/x×]\s*\d+|\d+\s*[-+*/×]\s*\d+\s*=\s*\?/i;
/** Слова поездки: вопрос с ними — не викторина и не знакомство, а дело для инструментов. */
export const TRIP_WORDS_RE = /камчат|kamchatka|вулкан|volcano|тур(?:ы|а|ов)?\b|\btours?\b|рыбал|fishing|медвед|bear|гейзер|geyser|заявк|booking|поездк|trip|петропавловск|petropavlovsk/i;

/**
 * Признаки ЧП важнее отказа: вопрос про беду в поле (даже рядом со словом
 * «инвестиционный») идёт в обычный путь, где сервер ставит блок 112.
 */
export function agentOffTopic(text: string): boolean {
  if (detectEmergency(text).detected) return false;
  if (CRYPTO_RE.test(text)) return true;
  return QUIZ_RE.test(text) && !TRIP_WORDS_RE.test(text);
}

const isEnglish = (text: string) => !/[а-яё]/i.test(text) && /[a-z]/i.test(text);

export const OFF_TOPIC_RU =
  'Спасибо, но это не по теме: на викторины, загадки и крипто- или инвестпредложения я не отвечаю. '
  + 'Помогаю с поездками на Камчатку — туры, места, погода, безопасность. Заявку на тур можно оставить, её подтверждает оператор.';
export const OFF_TOPIC_EN =
  'Thanks, but that is off-topic: I do not answer quizzes, puzzles, or crypto and investment offers. '
  + 'I help with trips to Kamchatka — tours, places, weather, safety. You can leave a tour request; the operator confirms it.';

export function offTopicReply(text: string): string {
  return isEnglish(text) ? OFF_TOPIC_EN : OFF_TOPIC_RU;
}
