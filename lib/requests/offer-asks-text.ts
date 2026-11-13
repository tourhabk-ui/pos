/**
 * lib/requests/offer-asks-text.ts — слова и кнопки вопроса другим компаниям
 * после отказа («возьмёте на эту дату?», план «после отказа», этап 4б).
 *
 * Вопрос — не заявка: в нём нет ни имени, ни телефона человека, только место,
 * дата, число людей и тур самой компании. Согласие человек давал одному
 * оператору, поэтому другим уходит вопрос; заявку компании, ответившей
 * «Беру», человек оставляет сам.
 *
 * Здесь только слова и разбор кнопок — без базы. Сторож:
 * tests/unit/offer-asks.test.ts.
 */
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { escapeHtml } from '@/lib/text/escape-html';

export type OfferAskAnswer = 'take' | 'decline';

/** Кнопки вопроса: `oq:y:<номер вопроса>` — «Беру», `oq:n:<номер>` — «Не могу». Обе пишут — обе подписаны. */
const ASK_PRESS = /^oq:([yn]):([0-9]{1,18})$/;

export function isOfferAskPayload(payload: string): boolean {
  return payload.startsWith('oq:');
}

export function offerAskPayload(askId: string, answer: OfferAskAnswer): string {
  return `oq:${answer === 'take' ? 'y' : 'n'}:${askId}`;
}

export function offerAskButtons(askId: string, nowMs?: number): Array<{ text: string; payload: string }> {
  return [
    { text: 'Беру', payload: signPayload(offerAskPayload(askId, 'take'), nowMs) },
    { text: 'Не могу', payload: signPayload(offerAskPayload(askId, 'decline'), nowMs) },
  ];
}

export function parseOfferAskPress(payload: string): { askId: string; answer: OfferAskAnswer } | null {
  const m = ASK_PRESS.exec(payload);
  return m ? { askId: m[2]!, answer: m[1] === 'y' ? 'take' : 'decline' } : null;
}

function ruDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

const ANSWER_WORD: Record<OfferAskAnswer, string> = { take: '«Беру»', decline: '«Не могу»' };

export interface OfferAskFacts {
  placeName: string;
  /** Дата заявки, ISO. */
  date: string;
  people: number;
  /** Тур компании, которой задан вопрос. */
  tourTitle: string;
}

/**
 * Вопрос компании. Один текст на MAX и Telegram: ПД в нём нет по построению.
 * Сказано, что это не заявка, что будет после каждого ответа и что тот же
 * вопрос получили другие компании — без очереди и без выбора Ведара.
 */
export function offerAskText(a: OfferAskFacts): string {
  return [
    '<b>Вопрос от Ведара — это не заявка</b>',
    `Человеку отказала другая компания: тур к месту «${escapeHtml(a.placeName)}» на ${ruDay(a.date)}, ${a.people} чел.`,
    `У вас к этому месту есть тур «${escapeHtml(a.tourTitle)}». Возьмёте на эту дату?`,
    'Имени и телефона в вопросе нет. Ответите «Беру» — человек увидит, что ваша компания готова его принять, и сам оставит вам заявку. '
      + 'Ответите «Не могу» — в его списке вашей компании не будет.',
    'Такой же вопрос получили другие компании с турами к этому месту — всем сразу, по общему правилу.',
  ].join('\n');
}

/** Чем кончилось нажатие — для слов компании. */
export type OfferAskOutcome =
  /** «Беру» записано, человеку сообщено в чат. */
  | { state: 'took'; told: 'max' | 'telegram'; date: string; tourTitle: string }
  /** «Беру» записано; чат человека не принял или его нет — письмо о «Беру» принял менеджер Ведара. */
  | { state: 'took'; told: 'manager'; date: string; tourTitle: string }
  /** «Беру» записано; ни чат человека, ни менеджер письма не приняли — ответ виден только в статусе заявки. */
  | { state: 'took'; told: 'status'; date: string; tourTitle: string }
  /** «Беру» записано, но заявка человека с тех пор изменилась — ему ничего не отправлено. */
  | { state: 'took'; told: 'outgrown' }
  /** «Беру» записано, но тур сейчас не показать: его нет на витрине или дата закрыта в календаре. */
  | { state: 'took'; told: 'unlisted' }
  /** «Беру» записано; что с заявкой человека — проверить не удалось, ему ничего не отправлено. */
  | { state: 'took'; told: 'unknown' }
  /** «Беру» записано; сообщение человеку не уложилось в срок нажатия и идёт само — дошло ли, ещё неизвестно. */
  | { state: 'took'; told: 'sending' }
  | { state: 'declined' }
  | { state: 'already'; answer: OfferAskAnswer }
  /** Вопроса с таким номером у этой компании нет. */
  | { state: 'not_yours' }
  | { state: 'date_passed' }
  | { state: 'failed' };

const ASK_LATER = 'Заявку он оставит сам — она придёт вам обычной заявкой с его контактами.';

/** Ответ компании на её нажатие: что записано и что на деле узнал человек. */
export function offerAskReplyText(o: OfferAskOutcome): string {
  switch (o.state) {
    case 'took':
      if (o.told === 'max' || o.told === 'telegram') {
        return `Записал: «Беру». Человеку сообщено в ${o.told === 'max' ? 'MAX' : 'Telegram'}: ваша компания готова принять его ${ruDay(o.date)} — тур «${escapeHtml(o.tourTitle)}». ${ASK_LATER}`;
      }
      if (o.told === 'manager') {
        return `Записал: «Беру». Сообщить человеку в чат не удалось или чата у него нет — ваш ответ передан менеджеру Ведара, чтобы он сообщил человеку; на странице заявки человека ответ тоже стоит. ${ASK_LATER}`;
      }
      if (o.told === 'status') {
        return `Записал: «Беру». Сообщить человеку в чат не удалось или чата у него нет — ваш ответ он увидит на странице своей заявки или узнает от своего ИИ-помощника. ${ASK_LATER}`;
      }
      if (o.told === 'outgrown') {
        return 'Записал: «Беру». Но заявка человека с тех пор изменилась — он выбрал другую дату, отменил её или его уже приняли. Ему ничего не отправлено.';
      }
      if (o.told === 'unlisted') {
        return 'Записал: «Беру». Но показать ваш тур человеку сейчас нельзя: тура нет на витрине или эта дата закрыта в его календаре. Ему ничего не отправлено.';
      }
      if (o.told === 'sending') {
        return 'Записал: «Беру». Сообщение человеку отправляется — дошло ли, пока неизвестно; ваш ответ он в любом случае увидит на странице своей заявки.';
      }
      return 'Записал: «Беру». Проверить заявку человека сейчас не удалось — ему ничего не отправлено; ваш ответ он увидит на странице своей заявки.';
    case 'declined':
      return 'Записал: «Не могу». В списке этого человека вашей компании не будет.';
    case 'already':
      return `Вы уже ответили на этот вопрос: ${ANSWER_WORD[o.answer]}. Ответ один — второй раз не записываю.`;
    case 'not_yours':
      return 'Этот вопрос задан не вашей компании. Ничего не записал.';
    case 'date_passed':
      return 'Дата в вопросе уже прошла. Ничего не записал.';
    case 'failed':
      return 'Не удалось записать ответ. Повторите через минуту.';
  }
}

/**
 * Человеку: компания сама ответила, что возьмёт. Это ответ на вопрос Ведара,
 * не бронь; заявку он оставляет сам, и телефон получит только эта компания.
 */
export function offerTookText(a: {
  partnerName: string; tourTitle: string; price: string | null; date: string; people: number | null; url: string;
}): string {
  // Число людей — до цены: строка кончается ценой, а не сокращением «чел.» с точкой.
  const facts = `Тур «${escapeHtml(a.tourTitle)}»${a.people ? ` на ${a.people} чел.` : ''}, ${escapeHtml(a.price ?? 'цена не указана')}`;
  return [
    `<b>Компания «${escapeHtml(a.partnerName)}» ответила Ведару: возьмёт вас ${ruDay(a.date)}</b>`,
    `${facts}.`,
    `Это ответ на вопрос Ведара, ещё не бронь. Заявку вы оставляете сами: ${escapeHtml(a.url)}`,
    'Имя и телефон получит только эта компания.',
  ].join('\n');
}

const CHANNEL_WORD: Record<string, string> = { max: 'MAX', telegram: 'Telegram' };

/** Почему письмо менеджеру: чата у человека нет или какие чаты не приняли (коды отправки, без id чатов). */
function triedChatsWords(tried: readonly string[]): string {
  if (tried.length === 0) return 'чата с Ведаром у клиента нет';
  return tried.map((t) => {
    const [ch, code] = t.split(':');
    return `${CHANNEL_WORD[ch ?? ''] ?? 'чат'} клиента сообщение не принял (${code ?? 'api_error'})`;
  }).join('; ');
}

/**
 * Менеджеру: компания ответила «Беру», а человеку сообщить некуда — позвонить
 * (правило плана «доставлено»: не дошло — сразу менеджеру). `text` с именем и
 * телефоном уходит только в MAX (sendPdAlert), `stub` — без ПД.
 */
export function managerTookText(a: {
  leadId: string; partnerName: string; tourTitle: string; price: string | null; date: string; people: number | null; url: string;
  /** Чаты человека, не принявшие сообщение: `max:bad_id`. Пусто — чата нет. */
  tried: readonly string[];
}, contact: { name: string | null; phone: string | null }): { text: string; stub: string } {
  const title = '<b>Другая компания ответила «Беру» — клиенту не сообщено, позвонить</b>';
  const facts = `тур «${escapeHtml(a.tourTitle)}»${a.people ? ` на ${a.people} чел.` : ''}, ${escapeHtml(a.price ?? 'цена не указана')}`;
  const what = `Заявка <code>${escapeHtml(a.leadId)}</code>: после отказа Ведар спросил другие компании. `
    + `«${escapeHtml(a.partnerName)}» ответила: возьмёт ${ruDay(a.date)} — ${facts}.`;
  const text = [
    title,
    what,
    `Это слово компании, ещё не бронь: заявку клиент оставляет ей сам — ${escapeHtml(a.url)}`,
    `<b>Имя:</b> ${escapeHtml(contact.name ?? 'не записано')}`,
    `<b>Телефон:</b> ${escapeHtml(contact.phone ?? 'не записан')}`,
    `Почему письмо: ${triedChatsWords(a.tried)}.`,
    'На странице заявки клиента ответ компании стоит. ИИ-агенту клиента, если заявку создавал он, уведомление о «Беру» не уходит — он прочтёт ответ в статусе заявки.',
  ].join('\n');
  // Заглушка уходит, когда MAX письмо не принял: звать в MAX за телефоном нельзя — его там нет.
  const stub = [
    title,
    what,
    'MAX не сработал: имя и телефон — в админке (кнопка ниже), в Telegram они не передаются.',
  ].join('\n');
  return { text, stub };
}

/** Отказавшему оператору: что сделал Ведар после его ответа (строка к исходу сообщения туристу). */
export function offerAsksOperatorLine(sent: number): string | null {
  if (sent <= 0) return null;
  return sent === 1
    ? 'Одной другой компании с туром к этому месту задан вопрос, возьмёт ли она туриста на эту дату, — без его имени и телефона.'
    : `Другим компаниям с турами к этому месту (${sent}) задан вопрос, возьмут ли они туриста на эту дату, — без его имени и телефона.`;
}
