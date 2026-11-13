/**
 * Что понадобится для заявки — агенту заранее, в разговоре текстом (слово
 * владельца 13.11: «как Кузьмич запрашивает согласие, может, согласие не
 * доходит?»).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Кузьмич в A2A заявок не оформляет: агент создаёт их сам вызовом
 * инструмента. О согласии он говорил, а об имени и телефоне — нет, и говорил
 * не всегда: это решала модель. Агент узнавал, что нужны три вещи, только из
 * отказа, когда человек уже ушёл из разговора.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Детерминированная приписка к ответу, а не ещё один абзац промпта (§8
 * CLAUDE.md: критичное — серверным правилом): спросили, как забронировать или
 * оставить заявку, — в ответе названы имя, телефон и согласие. Если модель
 * уже назвала все три, приписки нет. Язык — по письменности вопроса.
 *
 * Чистый модуль. Сторож: tests/unit/a2a-request-needs-note.test.ts.
 */

const ASKS_RU = /заброниров|бронир|брон[ьи]|(остав|оформ|пода|отправ|созда)[а-яё]*\s+заявк|запи(сать|шите|ши)(ся)?\s+на\s/i;
const ASKS_EN = /\b(book|booking|bookings|reserve|reservation|sign\s+(me|us|them)\s+up|(place|make|submit|create|send)\s+(a|an|the)\s+(booking|reservation|request|order))\b/i;
const ASKS_ZH = /预订|预定|订票|下单|报名|预约/;

/** Агент спрашивает, как забронировать или оставить заявку. */
export function asksHowToRequest(question: string): boolean {
  return ASKS_RU.test(question) || ASKS_EN.test(question) || ASKS_ZH.test(question);
}

const HAS_CONSENT = /consent|согласи|同意/i;
const HAS_PHONE = /phone|телефон|电话|手机/i;
// Кириллицу `\b` не видит — границы слова у «имя» заданы соседними буквами.
const HAS_NAME = /\bname\b|(^|[^а-яё])им(я|ени|енем)(?![а-яё])|姓名|名字/i;

/** В ответе уже названы все три вещи: имя, телефон и согласие. */
export function namesAllThree(answer: string): boolean {
  return HAS_CONSENT.test(answer) && HAS_PHONE.test(answer) && HAS_NAME.test(answer);
}

export const REQUEST_NEEDS_NOTE = {
  ru: 'Для заявки заранее спросите у человека три вещи: имя, телефон и согласие на обработку и передачу персональных данных. '
    + 'Заявку вы создаёте сами — вызовом инструмента с этими полями и consent: true; без согласия заявка не создаётся.',
  en: 'Before placing a request, ask the person for three things: their name, their phone number and their consent to the processing and transfer of personal data. '
    + 'You create the request yourself — by calling the tool with these fields and consent: true; without consent the request is not created.',
  zh: '提交申请前，请先向当事人确认三项：姓名、电话，以及是否同意处理和传输其个人数据。'
    + '申请由您自行调用工具创建——传入这些字段并设置 consent: true；未经同意，申请不会被创建。',
} as const;

type Lang = keyof typeof REQUEST_NEEDS_NOTE;

/** Язык приписки — по письменности вопроса: иероглифы, кириллица, иначе английский. */
export function noteLanguage(question: string): Lang {
  if (/[\u4e00-\u9fff]/.test(question)) return 'zh';
  return /[а-яё]/i.test(question) ? 'ru' : 'en';
}

/** Приписка к ответу; null — вопрос не про заявку либо ответ уже называет всё. */
export function requestNeedsNote(question: string, answer: string): string | null {
  if (!asksHowToRequest(question) || namesAllThree(answer)) return null;
  return REQUEST_NEEDS_NOTE[noteLanguage(question)];
}
