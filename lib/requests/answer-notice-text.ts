/**
 * lib/requests/answer-notice-text.ts — слова сообщения после ответа
 * туроператора кнопкой (план «после отказа», этап 2б; слово владельца 11.11).
 *
 * Три адресата, без базы:
 *  - человеку — что ответил оператор и что можно сделать дальше; ПД нет
 *    (тур, дата, число людей, вывеска оператора), текст один для MAX и
 *    Telegram;
 *  - менеджеру Ведара, когда до человека не дошло, — с именем и телефоном
 *    (только в `text` sendPdAlert, то есть в MAX), заглушка без ПД;
 *  - оператору — что ушло человеку на самом деле.
 *
 * Отказ по погоде или безопасности (слово владельца 11.11, вопрос 3): замену
 * предлагать можно только проверенно безопасную. Проверка дат по прогнозу и
 * обстановке — следующий шаг (2в), поэтому здесь дат после такого отказа нет:
 * непроверенная дата под словами «вместо погоды» была бы обещанием, которого
 * система не держит. Слово «безопасно» не говорится ни о чём.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { DECLINE_REASON_LABEL, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { myTripDateMenuPayload, myTripDatePickPayload } from '@/lib/requests/my-trip-ask';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';

export type NoticeAnswer = 'no_seats' | 'decline' | 'other_date';

/** Факты заявки для слов — без имени и телефона. */
export interface NoticeFacts {
  leadId: string;
  answer: NoticeAnswer;
  reason: DeclineReason | null;
  tourTitle: string | null;
  /** Полный адрес карточки тура; null — тура на витрине нет или не записан. */
  tourUrl: string | null;
  /** Дата заявки, ISO; null — не записана. */
  date: string | null;
  people: number | null;
  operatorName: string | null;
  /** Большая группа, которую после отказа увидят другие операторы (followup-scope). */
  groupPassedOn: boolean;
}

/** Свободные даты рядом — что удалось узнать. */
export type DatesBlock =
  | { kind: 'dates'; dates: string[] }
  | { kind: 'none' }
  | { kind: 'no_calendar' }
  | { kind: 'failed' }
  /** Блока нет по смыслу ответа: погода, большая группа, «не подходит группа». */
  | { kind: 'skip' };

/** Чем кончилось сообщение человеку — для оператора и менеджера. */
export type NoticeOutcome =
  | { state: 'delivered'; via: 'max' | 'telegram' | 'agent_webhook' | 'agent_read' | 'page_seen'; dates: string[] }
  | { state: 'undelivered'; manager: 'max' | 'telegram-stub' | 'none'; hadChat: boolean }
  | { state: 'skipped'; reason: 'lead_closed' | 'not_addressee' | 'self' | 'outgrown' }
  /** Сбой посреди отправки: повторит добивка. */
  | { state: 'pending' };

export function ruDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** «13.01, 14.01»; год — если он не тот, что у даты заявки. */
export function datesLine(dates: readonly string[], around: string | null): string {
  const year = around?.slice(0, 4) ?? null;
  return dates.map((d) => (d.slice(0, 4) === year ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : ruDay(d))).join(', ');
}

const who = (f: NoticeFacts) => (f.operatorName ? `Оператор «${escapeHtml(f.operatorName)}»` : 'Оператор');

function head(f: NoticeFacts): string {
  const parts = [
    f.tourTitle ? `Тур «${escapeHtml(f.tourTitle)}»` : 'Заявка на тур',
    f.date ? ruDay(f.date) : null,
    f.people && f.people > 0 ? `${f.people} чел.` : null,
  ].filter(Boolean);
  return `<b>Ответ по вашей заявке</b>\n${parts.join(', ')}.`;
}

/** Есть ли у ответа блок дат по смыслу. */
export function answerWantsDates(f: Pick<NoticeFacts, 'answer' | 'reason' | 'groupPassedOn'>): boolean {
  if (f.groupPassedOn) return false;
  if (f.answer === 'decline') return f.reason !== 'weather' && f.reason !== 'group';
  return true;
}

/**
 * Кнопки дат — только где нажатие пройдёт: чат вправе менять дату этой
 * заявки (`canPick`), и ответ её не закрыл. После «Отказать» заявка `lost`,
 * и «Изменить дату» ответило бы «заявка закрыта» (критика 11.11, п. 5).
 */
export function datesPickable(f: Pick<NoticeFacts, 'answer'>, canPick: boolean): boolean {
  return canPick && (f.answer === 'no_seats' || f.answer === 'other_date');
}

function datesText(f: NoticeFacts, d: DatesBlock, pick: boolean): string | null {
  const page = f.tourUrl ? ` Заявку на другую дату можно оставить на странице тура: ${f.tourUrl}` : '';
  switch (d.kind) {
    case 'skip':
      return null;
    case 'failed':
      return pick
        ? 'Свободные даты сейчас не прочитались — это сбой, а не «дат нет». Позже их покажет «Моя поездка» → «Изменить дату».'
        : `Свободные даты сейчас не прочитались — это сбой, а не «дат нет».${page}`;
    case 'no_calendar':
      return 'Расписания у тура на Ведаре нет — свободных дат показать не могу; другую дату можно спросить у оператора.';
    case 'none':
      return `Других свободных дат${f.people ? ` на ${f.people} чел.` : ''} в календаре тура на год вперёд нет.`;
    case 'dates': {
      const line = datesLine(d.dates, f.date);
      if (f.answer === 'other_date') {
        return pick
          ? `Если удобнее выбрать самому — свободные даты рядом по календарю тура: ${line}. Нажмите дату — оператор получит вашу просьбу перенести; места подтверждает он.`
          : `Свободные даты рядом по календарю тура: ${line}. Места на них подтверждает оператор.`;
      }
      return pick
        ? `Свободные даты рядом с вашей — по календарю тура на Ведаре: ${line}. Это не ответ оператора: места на них подтверждает он. Нажмите дату — она сразу встанет в заявку, и оператор получит её с кнопками ответа.`
        : `Свободные даты рядом с вашей — по календарю тура на Ведаре: ${line}. Места на них подтверждает оператор.${page}`;
    }
  }
}

function answerLine(f: NoticeFacts): string {
  if (f.groupPassedOn) {
    return `${who(f)} не может взять всю группу${f.people ? ` (${f.people} чел.)` : ''} на эту дату. `
      + 'Заявку на группу увидят другие операторы того же вида туров — новую заявку заводить не нужно; ждите звонка по телефону из заявки.';
  }
  if (f.answer === 'no_seats') return `${who(f)} ответил: на эту дату мест нет. Это ответ на заявку — брони не было, оплату Ведар не принимает.`;
  if (f.answer === 'other_date') return `${who(f)} ответил: на эту дату не может и предложит другую — напишет или позвонит по телефону из заявки.`;
  switch (f.reason) {
    case 'weather':
      return `${who(f)} отказал по заявке: на эту дату — погода или безопасность. Решение о выезде за оператором. `
        + 'Другие даты здесь не предлагаю: безопасна ли дата, видно только по прогнозу и обстановке ближе к ней — спросите о ней здесь, в чате. Экстренный вызов — 112.';
    case 'seats':
      return `${who(f)} отказал по заявке: мест нет. Заявка закрыта; брони не было, оплату Ведар не принимает.`;
    case 'dates':
      return `${who(f)} отказал по заявке: даты не подходят. Возможно, в эти дни тур не ходит — даты ниже взяты только из календаря.`;
    case 'group':
      return `${who(f)} отказал по заявке: не подходит группа. Что именно — число людей или состав, — можно спросить у оператора${f.tourUrl ? `: контакты на странице тура ${f.tourUrl}` : ''}.`;
    default:
      return `${who(f)} отказал по заявке; причину он не уточнил.`;
  }
}

const TAIL = 'Подобрать другой тур можно здесь же — напишите, что ищете.';

/**
 * Сообщение человеку. `canPick` — чат вправе менять дату этой заявки
 * (тогда даты — кнопками «Изменить дату», иначе текстом и ссылкой на тур).
 */
export function touristAnswerText(
  f: NoticeFacts, d: DatesBlock, canPick: boolean,
): { text: string; buttons: Array<{ text: string; payload: string }> } {
  const pick = datesPickable(f, canPick);
  const block = answerWantsDates(f) ? datesText(f, d, pick) : null;
  const weather = f.answer === 'decline' && f.reason === 'weather';
  const lines = [head(f), answerLine(f), block, weather || f.groupPassedOn ? null : TAIL].filter((l): l is string => !!l);
  const buttons: Array<{ text: string; payload: string }> = [];
  if (pick && block && d.kind === 'dates') {
    for (const iso of d.dates) {
      buttons.push({ text: datesLine([iso], f.date), payload: signPayload(myTripDatePickPayload(f.leadId, iso)) });
    }
    buttons.push({ text: 'Другие даты', payload: myTripDateMenuPayload(f.leadId) });
  }
  return { text: lines.join('\n'), buttons };
}

/** Ответ оператора словами — для менеджера. */
function answerShort(f: NoticeFacts): string {
  if (f.answer === 'no_seats') return 'мест нет';
  if (f.answer === 'other_date') return 'предложит другую дату';
  return `отказ — ${f.reason ? DECLINE_REASON_LABEL[f.reason].toLowerCase() : 'причина не указана'}`;
}

/** Куда пробовали — коды отправки словами (без id чатов). */
export function triedWords(tried: readonly string[]): string {
  const say: string[] = [];
  const chats = tried.filter((t) => t.startsWith('max:') || t.startsWith('telegram:'));
  if (chats.length === 0) say.push('чата с человеком нет');
  for (const t of chats) {
    const [ch, code] = t.split(':');
    say.push(`${ch === 'max' ? 'MAX' : 'Telegram'} не принял (${code})`);
  }
  const agent = tried.find((t) => t.startsWith('agent:'));
  say.push(agent ? `ИИ-агент уведомления не принял (${agent.slice(6)})` : 'подписки ИИ-агента нет');
  return say.join('; ');
}

/**
 * Менеджеру: до человека не дошло — позвонить. `text` с именем и телефоном
 * уходит только в MAX (sendPdAlert), `stub` — без ПД.
 */
export function managerUndeliveredText(
  f: NoticeFacts, contact: { name: string | null; phone: string | null }, tried: readonly string[], dates: readonly string[],
): { text: string; stub: string } {
  const tour = [f.tourTitle ? `тур «${escapeHtml(f.tourTitle)}»` : 'тур', f.date ? ruDay(f.date) : null, f.people ? `${f.people} чел.` : null]
    .filter(Boolean).join(', ');
  const title = '<b>Ответ оператора не доставлен клиенту — позвонить</b>';
  const answer = `Ответ ${f.operatorName ? `оператора «${escapeHtml(f.operatorName)}»` : 'оператора'}: ${answerShort(f)}.`;
  const datesNote = dates.length > 0 ? `Свободные даты рядом по календарю: ${datesLine(dates, f.date)} — места подтверждает оператор.` : null;
  const text = [
    title,
    `Заявка <code>${escapeHtml(f.leadId)}</code>: ${tour}.`,
    answer,
    `<b>Имя:</b> ${escapeHtml(contact.name ?? 'не записано')}`,
    `<b>Телефон:</b> ${escapeHtml(contact.phone ?? 'не записан')}`,
    `Куда пробовали: ${triedWords(tried)}.`,
    datesNote,
    'Брони не было; оплату Ведар не принимает. Если ИИ-агент или человек прочтёт статус позже — пришлю «звонить не нужно».',
  ].filter(Boolean).join('\n');
  const stub = [
    title,
    `Заявка <code>${escapeHtml(f.leadId)}</code>: ${tour}. ${answer}`,
    'Имя и телефон — в MAX рабочего чата и в админке: в Telegram они не передаются.',
  ].join('\n');
  return { text, stub };
}

const VIA_WORDS: Record<'agent_webhook' | 'agent_read' | 'page_seen', string> = {
  agent_webhook: 'уведомление ИИ-агенту принято',
  agent_read: 'ИИ-агент прочитал статус',
  page_seen: 'клиент открыл страницу заявки',
};

/** Менеджеру позже, без ПД: дошло — звонить не нужно. */
export function managerClearedText(leadId: string, via: NoticeOutcome & { state: 'delivered' }): string {
  const how = via.via === 'max' || via.via === 'telegram' ? `сообщение принял ${via.via === 'max' ? 'MAX' : 'Telegram'}` : VIA_WORDS[via.via];
  return `Заявка <code>${escapeHtml(leadId)}</code>: ответ оператора до клиента дошёл (${how}) — звонить не нужно.`;
}

/** Строка оператору: что на самом деле ушло человеку. */
export function operatorOutcomeLine(o: NoticeOutcome): string {
  switch (o.state) {
    case 'delivered':
      if (o.via === 'max' || o.via === 'telegram') {
        return `Туристу ушло сообщение в ${o.via === 'max' ? 'MAX' : 'Telegram'}: ваш ответ${o.dates.length > 0 ? ` и свободные даты тура рядом по календарю (${datesLine(o.dates, null)})` : ''}.`;
      }
      if (o.via === 'agent_webhook') return 'Ответ ушёл ИИ-агенту туриста: его уведомление принято.';
      return o.via === 'agent_read' ? 'Ваш ответ уже прочитал ИИ-агент туриста.' : 'Турист уже открыл страницу заявки и видит ваш ответ.';
    case 'undelivered': {
      const why = o.hadChat ? 'чат не принял сообщение' : 'чат с ним не подключён';
      const base = `Туристу сообщить не удалось: ${why}, ИИ-агент уведомления не принял.`;
      if (o.manager === 'max') return `${base} Заявку с телефоном получил менеджер Ведара — он позвонит.`;
      if (o.manager === 'telegram-stub') return `${base} Менеджеру Ведара ушло уведомление без телефона — номер он видит в админке.`;
      return `${base} И менеджеру Ведара сейчас не дошло — повторю автоматически. Если можете, позвоните заказчику сами по телефону из заявки.`;
    }
    case 'skipped':
      return {
        lead_closed: 'Заявка уже была закрыта — туристу ничего не отправлял.',
        not_addressee: 'Заявка сейчас не ваша по карточке — туристу ничего не отправлял.',
        self: 'Это тестовая заявка вашей карточки — туристу ничего не отправлял.',
        outgrown: 'Статус заявки уже сменился (бронь или новый ответ) — туристу ничего не отправлял.',
      }[o.reason];
    case 'pending':
      return 'Сообщение туристу сейчас не ушло — повторю автоматически в течение получаса, не выйдет — передам менеджеру Ведара.';
  }
}
